/**
 * Cluster Management Module
 *
 * Provides cluster status and node management functionality for Kubernetes-based
 * Umbrel deployments. This module interfaces with the KubernetesRuntime to provide
 * cluster visibility and control through the UI.
 *
 * @module cluster
 */

import {$} from 'execa'
import type Umbreld from '../../index.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ClusterNode {
	name: string
	status: 'Ready' | 'NotReady' | 'Unknown'
	role: 'control-plane' | 'worker'
	ip: string
	kubeletVersion: string
	os: string
	arch: string
	cpuCapacity: string
	memoryCapacity: string
	createdAt: string
	schedulable: boolean
}

export interface ClusterStatus {
	enabled: boolean
	connected: boolean
	version: string
	nodes: ClusterNode[]
	totalCpu: number
	totalMemoryGb: number
	healthyNodes: number
	totalNodes: number
}

export interface ClusterConfig {
	kubeconfig: string
	namespace: string
	storageClass: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster Class
// ─────────────────────────────────────────────────────────────────────────────

export class Cluster {
	readonly #umbreld: Umbreld
	readonly #logger: Umbreld['logger']

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		this.#logger = umbreld.logger.createChildLogger('cluster')
	}

	/**
	 * Check if Kubernetes runtime is enabled
	 */
	async isEnabled(): Promise<boolean> {
		try {
			const containerRuntime = await this.#umbreld.store.get('settings.containerRuntime')
			return containerRuntime?.type === 'kubernetes'
		} catch {
			return false
		}
	}

	/**
	 * Get cluster configuration
	 */
	async getConfig(): Promise<ClusterConfig> {
		const containerRuntime = await this.#umbreld.store.get('settings.containerRuntime')
		const kubeconfig = containerRuntime?.kubeconfig || '/etc/rancher/k3s/k3s.yaml'
		const namespace = containerRuntime?.namespace || 'umbrel'
		const storageClass = containerRuntime?.storageClass || 'local-path'

		return {kubeconfig, namespace, storageClass}
	}

	/**
	 * Execute kubectl command
	 */
	async #kubectl(...args: string[]): Promise<{stdout: string; stderr: string}> {
		const config = await this.getConfig()
		return $`kubectl --kubeconfig ${config.kubeconfig} ${args}`
	}

	/**
	 * Get cluster status
	 */
	async getStatus(): Promise<ClusterStatus> {
		const enabled = await this.isEnabled()

		if (!enabled) {
			return {
				enabled: false,
				connected: false,
				version: '',
				nodes: [],
				totalCpu: 0,
				totalMemoryGb: 0,
				healthyNodes: 0,
				totalNodes: 0,
			}
		}

		try {
			// Get cluster version
			const {stdout: versionOutput} = await this.#kubectl('version', '--output=json')
			const versionInfo = JSON.parse(versionOutput)
			const version = versionInfo.serverVersion?.gitVersion || 'unknown'

			// Get nodes
			const nodes = await this.getNodes()

			// Calculate totals
			const healthyNodes = nodes.filter((n) => n.status === 'Ready').length
			const totalCpu = nodes.reduce((sum, n) => sum + parseInt(n.cpuCapacity || '0', 10), 0)
			const totalMemoryGb = nodes.reduce((sum, n) => {
				const memKi = parseInt(n.memoryCapacity?.replace('Ki', '') || '0', 10)
				return sum + memKi / 1024 / 1024
			}, 0)

			return {
				enabled: true,
				connected: true,
				version,
				nodes,
				totalCpu,
				totalMemoryGb: Math.round(totalMemoryGb * 10) / 10,
				healthyNodes,
				totalNodes: nodes.length,
			}
		} catch (error) {
			this.#logger.error('Failed to get cluster status', error)
			return {
				enabled: true,
				connected: false,
				version: '',
				nodes: [],
				totalCpu: 0,
				totalMemoryGb: 0,
				healthyNodes: 0,
				totalNodes: 0,
			}
		}
	}

	/**
	 * Get all cluster nodes
	 */
	async getNodes(): Promise<ClusterNode[]> {
		try {
			const {stdout} = await this.#kubectl('get', 'nodes', '-o', 'json')
			const nodesData = JSON.parse(stdout)

			return nodesData.items.map((node: any) => {
				const labels = node.metadata?.labels || {}
				const status = node.status?.conditions?.find((c: any) => c.type === 'Ready')
				const addresses = node.status?.addresses || []
				const internalIp = addresses.find((a: any) => a.type === 'InternalIP')?.address || ''
				// Node is schedulable unless spec.unschedulable is true (cordoned)
				const schedulable = node.spec?.unschedulable !== true

				return {
					name: node.metadata?.name || 'unknown',
					status: status?.status === 'True' ? 'Ready' : status?.status === 'False' ? 'NotReady' : 'Unknown',
					role: labels['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane' : 'worker',
					ip: internalIp,
					kubeletVersion: node.status?.nodeInfo?.kubeletVersion || '',
					os: node.status?.nodeInfo?.osImage || '',
					arch: node.status?.nodeInfo?.architecture || '',
					cpuCapacity: node.status?.capacity?.cpu || '0',
					memoryCapacity: node.status?.capacity?.memory || '0',
					createdAt: node.metadata?.creationTimestamp || '',
					schedulable,
				}
			})
		} catch (error) {
			this.#logger.error('Failed to get nodes', error)
			return []
		}
	}

	/**
	 * Get node details
	 */
	async getNode(name: string): Promise<ClusterNode | null> {
		const nodes = await this.getNodes()
		return nodes.find((n) => n.name === name) || null
	}

	/**
	 * Generate join command for adding a worker node
	 * This generates a token that can be used by another device to join the cluster
	 */
	async getJoinCommand(): Promise<string> {
		try {
			// For K3s, we need to get the node token and server address
			const config = await this.getConfig()

			// Get server URL from kubeconfig
			const {stdout: kubeconfigContent} = await $`cat ${config.kubeconfig}`
			const kubeconfigData = JSON.parse(kubeconfigContent.replace(/^apiVersion:.*$/m, '{"apiVersion":').replace(/\n/g, ''))
			const serverUrl = kubeconfigData.clusters?.[0]?.cluster?.server || ''

			// For K3s, the token is in /var/lib/rancher/k3s/server/node-token
			const {stdout: token} = await $`sudo cat /var/lib/rancher/k3s/server/node-token`

			return `curl -sfL https://get.k3s.io | K3S_URL=${serverUrl} K3S_TOKEN=${token.trim()} sh -`
		} catch (error) {
			this.#logger.error('Failed to generate join command', error)
			throw new Error('Failed to generate join command. Make sure K3s is running as the control plane.')
		}
	}

	/**
	 * Remove a node from the cluster
	 */
	async removeNode(name: string): Promise<boolean> {
		try {
			// Drain the node first (safely evict pods)
			await this.#kubectl('drain', name, '--ignore-daemonsets', '--delete-emptydir-data', '--force')

			// Delete the node
			await this.#kubectl('delete', 'node', name)

			this.#logger.log(`Removed node ${name} from cluster`)
			return true
		} catch (error) {
			this.#logger.error(`Failed to remove node ${name}`, error)
			throw new Error(`Failed to remove node ${name}`)
		}
	}

	/**
	 * Cordon a node (mark as unschedulable)
	 */
	async cordonNode(name: string): Promise<boolean> {
		try {
			await this.#kubectl('cordon', name)
			this.#logger.log(`Cordoned node ${name}`)
			return true
		} catch (error) {
			this.#logger.error(`Failed to cordon node ${name}`, error)
			throw new Error(`Failed to cordon node ${name}`)
		}
	}

	/**
	 * Uncordon a node (mark as schedulable)
	 */
	async uncordonNode(name: string): Promise<boolean> {
		try {
			await this.#kubectl('uncordon', name)
			this.#logger.log(`Uncordoned node ${name}`)
			return true
		} catch (error) {
			this.#logger.error(`Failed to uncordon node ${name}`, error)
			throw new Error(`Failed to uncordon node ${name}`)
		}
	}

	/**
	 * Enable Kubernetes runtime
	 */
	async enable(kubeconfig?: string): Promise<boolean> {
		try {
			const currentConfig = (await this.#umbreld.store.get('settings.containerRuntime')) || {}
			await this.#umbreld.store.set('settings.containerRuntime', {
				...currentConfig,
				type: 'kubernetes',
				...(kubeconfig && {kubeconfig}),
			})
			this.#logger.log('Kubernetes runtime enabled')
			return true
		} catch (error) {
			this.#logger.error('Failed to enable Kubernetes runtime', error)
			throw new Error('Failed to enable Kubernetes runtime')
		}
	}

	/**
	 * Disable Kubernetes runtime (switch back to Docker Compose)
	 */
	async disable(): Promise<boolean> {
		try {
			const currentConfig = (await this.#umbreld.store.get('settings.containerRuntime')) || {}
			await this.#umbreld.store.set('settings.containerRuntime', {
				...currentConfig,
				type: 'docker-compose',
			})
			this.#logger.log('Kubernetes runtime disabled, using Docker Compose')
			return true
		} catch (error) {
			this.#logger.error('Failed to disable Kubernetes runtime', error)
			throw new Error('Failed to disable Kubernetes runtime')
		}
	}
}
