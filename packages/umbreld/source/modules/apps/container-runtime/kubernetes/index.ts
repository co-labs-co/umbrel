/**
 * Kubernetes Runtime Implementation for Umbrel
 *
 * This module implements the ContainerRuntime interface for Kubernetes (K3s),
 * allowing Umbrel to deploy apps on Kubernetes clusters instead of Docker Compose.
 *
 * Key features:
 * - Uses K3s with built-in Helm Controller
 * - Namespace-based isolation (umbrel namespace)
 * - Local-path storage provisioner for PVCs
 * - Traefik ingress for external access
 *
 * @see https://github.com/co-labs-co/umbrel/issues/1
 * @module container-runtime/kubernetes
 */

import fse from 'fs-extra'
import {$} from 'execa'
import pRetry from 'p-retry'
import yaml from 'js-yaml'
import stripAnsi from 'strip-ansi'

import type {
	ContainerRuntime,
	ContainerRuntimeConfig,
	RuntimeType,
	InstallAppOptions,
	StopAppOptions,
	AppStatus,
	ServiceStatus,
	ServiceEndpoint,
	RuntimeLogger,
} from '../types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml'
const DEFAULT_NAMESPACE = 'umbrel'
const DEFAULT_STORAGE_CLASS = 'local-path'

// ─────────────────────────────────────────────────────────────────────────────
// KubernetesRuntime Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * KubernetesRuntime - K3s-based container runtime for Umbrel
 *
 * This runtime deploys apps to a K3s Kubernetes cluster, using:
 * - kubectl for cluster operations
 * - K3s HelmChart CRD for app lifecycle management
 * - Namespace isolation (all apps in 'umbrel' namespace)
 * - Local-path provisioner for storage
 * - Traefik ingress for external access
 *
 * @example
 * ```typescript
 * const runtime = new KubernetesRuntime({
 *   type: 'kubernetes',
 *   dataDirectory: '/data/umbrel',
 *   umbreld: umbreldInstance,
 *   namespace: 'umbrel',
 *   storageClass: 'local-path',
 * });
 * await runtime.startEnvironment();
 * await runtime.installApp('bitcoin', '/data/umbrel/app-data/bitcoin');
 * ```
 */
export class KubernetesRuntime implements ContainerRuntime {
	readonly type: RuntimeType = 'kubernetes'
	readonly config: ContainerRuntimeConfig

	private readonly kubeconfig: string
	private readonly namespace: string
	private readonly storageClass: string
	private readonly logger: RuntimeLogger

	constructor(config: ContainerRuntimeConfig) {
		this.config = config
		this.kubeconfig = config.kubeconfig ?? DEFAULT_KUBECONFIG
		this.namespace = config.namespace ?? DEFAULT_NAMESPACE
		this.storageClass = config.storageClass ?? DEFAULT_STORAGE_CLASS

		// Create a child logger if umbreld provides one
		this.logger = config.umbreld?.logger?.createChildLogger?.('kubernetes-runtime') ?? {
			log: console.log,
			error: console.error,
			verbose: () => {},
		}

		this.logger.log(`KubernetesRuntime initialized`)
		this.logger.log(`  kubeconfig: ${this.kubeconfig}`)
		this.logger.log(`  namespace:  ${this.namespace}`)
		this.logger.log(`  storage:    ${this.storageClass}`)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Private Helpers
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Execute kubectl command with proper kubeconfig
	 */
	private async kubectl(...args: string[]): Promise<{stdout: string; stderr: string}> {
		return $`kubectl --kubeconfig ${this.kubeconfig} ${args}`
	}

	/**
	 * Execute kubectl command in the umbrel namespace
	 */
	private async kubectlNs(...args: string[]): Promise<{stdout: string; stderr: string}> {
		return this.kubectl('-n', this.namespace, ...args)
	}

	/**
	 * Generate K8s manifests from docker-compose.yml
	 * Returns the directory containing generated manifests
	 */
	private async generateManifests(appId: string, dataDir: string): Promise<string> {
		const manifestsDir = `${dataDir}/k8s`
		const composeFile = `${dataDir}/docker-compose.yml`

		// Create manifests directory if not exists
		await fse.ensureDir(manifestsDir)

		// Check if compose file exists
		if (!(await fse.pathExists(composeFile))) {
			throw new Error(`docker-compose.yml not found for app ${appId}`)
		}

		// Read and parse compose file
		const composeContent = await fse.readFile(composeFile, 'utf8')
		const compose = yaml.load(composeContent) as any

		// Generate deployment and service for each compose service
		for (const [serviceName, serviceConfig] of Object.entries(compose.services || {})) {
			const service = serviceConfig as any
			const fullName = `${appId}-${serviceName}`

			// Generate Deployment
			const deployment = this.generateDeployment(appId, serviceName, service)
			await fse.writeFile(
				`${manifestsDir}/${serviceName}-deployment.yaml`,
				yaml.dump(deployment),
			)

			// Generate Service
			const k8sService = this.generateService(appId, serviceName, service)
			await fse.writeFile(
				`${manifestsDir}/${serviceName}-service.yaml`,
				yaml.dump(k8sService),
			)

			// Generate PVC if volumes are defined
			if (service.volumes && service.volumes.length > 0) {
				const pvc = this.generatePVC(appId, serviceName, service)
				await fse.writeFile(
					`${manifestsDir}/${serviceName}-pvc.yaml`,
					yaml.dump(pvc),
				)
			}

			// Generate ConfigMap for environment variables
			if (service.environment) {
				const configMap = this.generateConfigMap(appId, serviceName, service)
				await fse.writeFile(
					`${manifestsDir}/${serviceName}-configmap.yaml`,
					yaml.dump(configMap),
				)
			}
		}

		return manifestsDir
	}

	/**
	 * Generate Kubernetes Deployment from compose service
	 */
	private generateDeployment(appId: string, serviceName: string, service: any): object {
		const fullName = `${appId}-${serviceName}`
		const containerName = service.container_name || `${appId}_${serviceName}_1`

		// Parse environment variables
		const env: any[] = []
		if (service.environment) {
			if (Array.isArray(service.environment)) {
				for (const item of service.environment) {
					const [key, ...valueParts] = item.split('=')
					env.push({name: key, value: valueParts.join('=')})
				}
			} else {
				for (const [key, value] of Object.entries(service.environment)) {
					env.push({name: key, value: String(value)})
				}
			}
		}

		// Parse ports
		const ports: any[] = []
		if (service.ports) {
			for (const portSpec of service.ports) {
				let containerPort: number
				if (typeof portSpec === 'string') {
					const match = portSpec.match(/:(\d+)/)
					containerPort = match ? parseInt(match[1], 10) : parseInt(portSpec, 10)
				} else if (typeof portSpec === 'object' && portSpec.target) {
					containerPort = portSpec.target
				} else {
					continue
				}
				ports.push({containerPort})
			}
		}

		// Parse volume mounts
		const volumeMounts: any[] = []
		const volumes: any[] = []
		if (service.volumes) {
			for (let i = 0; i < service.volumes.length; i++) {
				const vol = service.volumes[i]
				let hostPath: string
				let mountPath: string

				if (typeof vol === 'string') {
					const parts = vol.split(':')
					hostPath = parts[0]
					mountPath = parts[1] || parts[0]
				} else if (typeof vol === 'object') {
					hostPath = vol.source
					mountPath = vol.target
				} else {
					continue
				}

				const volumeName = `vol-${i}`
				volumeMounts.push({name: volumeName, mountPath})

				// Use hostPath for existing data directories, PVC for others
				if (hostPath.startsWith('/')) {
					volumes.push({
						name: volumeName,
						hostPath: {
							path: hostPath,
							type: 'DirectoryOrCreate',
						},
					})
				} else {
					// Named volume - use PVC
					volumes.push({
						name: volumeName,
						persistentVolumeClaim: {
							claimName: `${fullName}-${volumeName}`,
						},
					})
				}
			}
		}

		return {
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: {
				name: fullName,
				namespace: this.namespace,
				labels: {
					app: appId,
					component: serviceName,
					'umbrel.io/app': appId,
				},
				annotations: {
					'umbrel.io/desired-replicas': '1',
					'umbrel.io/container-name': containerName,
				},
			},
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						app: appId,
						component: serviceName,
					},
				},
				template: {
					metadata: {
						labels: {
							app: appId,
							component: serviceName,
							'umbrel.io/app': appId,
						},
					},
					spec: {
						terminationGracePeriodSeconds: 60,
						containers: [
							{
								name: serviceName,
								image: service.image,
								ports,
								env,
								volumeMounts,
								...(service.command && {command: Array.isArray(service.command) ? service.command : ['/bin/sh', '-c', service.command]}),
								...(service.entrypoint && {args: Array.isArray(service.entrypoint) ? service.entrypoint : [service.entrypoint]}),
							},
						],
						volumes,
						...(service.restart === 'unless-stopped' || service.restart === 'always' 
							? {restartPolicy: 'Always'} 
							: {}),
					},
				},
			},
		}
	}

	/**
	 * Generate Kubernetes Service from compose service
	 */
	private generateService(appId: string, serviceName: string, service: any): object {
		const fullName = `${appId}-${serviceName}`

		// Parse ports
		const ports: any[] = []
		if (service.ports) {
			for (const portSpec of service.ports) {
				let port: number
				let targetPort: number

				if (typeof portSpec === 'string') {
					const parts = portSpec.split(':')
					if (parts.length === 2) {
						port = parseInt(parts[0], 10)
						targetPort = parseInt(parts[1], 10)
					} else {
						port = parseInt(parts[0], 10)
						targetPort = port
					}
				} else if (typeof portSpec === 'object') {
					port = portSpec.published || portSpec.target
					targetPort = portSpec.target
				} else {
					continue
				}

				ports.push({
					name: `port-${targetPort}`,
					port,
					targetPort,
					protocol: 'TCP',
				})
			}
		}

		// If no ports defined, expose all container ports from expose directive
		if (ports.length === 0 && service.expose) {
			for (const portSpec of service.expose) {
				const port = parseInt(portSpec, 10)
				ports.push({
					name: `port-${port}`,
					port,
					targetPort: port,
					protocol: 'TCP',
				})
			}
		}

		return {
			apiVersion: 'v1',
			kind: 'Service',
			metadata: {
				name: fullName,
				namespace: this.namespace,
				labels: {
					app: appId,
					component: serviceName,
					'umbrel.io/app': appId,
				},
			},
			spec: {
				type: 'ClusterIP',
				ports,
				selector: {
					app: appId,
					component: serviceName,
				},
			},
		}
	}

	/**
	 * Generate PersistentVolumeClaim for compose service
	 */
	private generatePVC(appId: string, serviceName: string, service: any): object {
		const fullName = `${appId}-${serviceName}`

		return {
			apiVersion: 'v1',
			kind: 'PersistentVolumeClaim',
			metadata: {
				name: `${fullName}-data`,
				namespace: this.namespace,
				labels: {
					app: appId,
					component: serviceName,
					'umbrel.io/app': appId,
				},
			},
			spec: {
				accessModes: ['ReadWriteOnce'],
				storageClassName: this.storageClass,
				resources: {
					requests: {
						storage: '10Gi', // Default, can be overridden
					},
				},
			},
		}
	}

	/**
	 * Generate ConfigMap for environment variables
	 */
	private generateConfigMap(appId: string, serviceName: string, service: any): object {
		const fullName = `${appId}-${serviceName}`
		const data: Record<string, string> = {}

		if (service.environment) {
			if (Array.isArray(service.environment)) {
				for (const item of service.environment) {
					const [key, ...valueParts] = item.split('=')
					data[key] = valueParts.join('=')
				}
			} else {
				for (const [key, value] of Object.entries(service.environment)) {
					data[key] = String(value)
				}
			}
		}

		return {
			apiVersion: 'v1',
			kind: 'ConfigMap',
			metadata: {
				name: `${fullName}-config`,
				namespace: this.namespace,
				labels: {
					app: appId,
					component: serviceName,
					'umbrel.io/app': appId,
				},
			},
			data,
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Environment Lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	async startEnvironment(): Promise<void> {
		this.logger.log('Starting Kubernetes environment...')

		// Create namespace if it doesn't exist
		// We use a simple create + ignore AlreadyExists approach
		try {
			await this.kubectl('create', 'namespace', this.namespace)
			this.logger.log(`Created namespace: ${this.namespace}`)
		} catch (error: unknown) {
			// Check if it's an "already exists" error (expected)
			const errorMessage = error instanceof Error ? error.message : String(error)
			if (errorMessage.includes('already exists')) {
				this.logger.verbose(`Namespace ${this.namespace} already exists`)
			} else {
				// Unexpected error - rethrow
				throw error
			}
		}

		// Verify namespace exists and is ready
		await this.kubectl('get', 'namespace', this.namespace)
		this.logger.verbose(`Verified namespace ${this.namespace} exists`)

		// TODO: Deploy base services (tor-proxy, app-auth, app-proxy) as K8s resources
		// For now, we just ensure the namespace exists

		this.logger.log(`Kubernetes environment started (namespace: ${this.namespace})`)
	}

	async stopEnvironment(): Promise<void> {
		this.logger.log('Stopping Kubernetes environment...')

		// Scale all deployments to 0 (preserve data)
		try {
			await this.kubectlNs('scale', 'deployment', '--all', '--replicas=0')
		} catch (error) {
			this.logger.error('Failed to scale down deployments', error)
		}

		this.logger.log('Kubernetes environment stopped')
	}

	async cleanState(): Promise<void> {
		this.logger.log('Cleaning Kubernetes state...')

		// Delete failed pods
		try {
			await this.kubectlNs('delete', 'pods', '--field-selector=status.phase=Failed')
		} catch {
			this.logger.verbose('No failed pods to clean')
		}

		// Delete evicted pods
		try {
			await this.kubectlNs('delete', 'pods', '--field-selector=reason=Evicted')
		} catch {
			this.logger.verbose('No evicted pods to clean')
		}

		// Force delete stuck terminating pods
		try {
			const {stdout} = await this.kubectlNs('get', 'pods', '--field-selector=status.phase=Terminating', '-o', 'name')
			if (stdout.trim()) {
				await this.kubectlNs('delete', 'pods', '--field-selector=status.phase=Terminating', '--grace-period=0', '--force')
			}
		} catch {
			this.logger.verbose('No terminating pods to force-delete')
		}

		this.logger.log('Kubernetes state cleaned')
	}

	// ─────────────────────────────────────────────────────────────────────────
	// App Lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	async installApp(appId: string, dataDir: string, options?: InstallAppOptions): Promise<void> {
		this.logger.log(`Installing app ${appId}...`)

		// Generate K8s manifests from docker-compose.yml
		const manifestsDir = await this.generateManifests(appId, dataDir)

		// Apply all manifests
		await pRetry(
			async () => {
				await this.kubectl('apply', '-f', manifestsDir, '-n', this.namespace)
			},
			{
				onFailedAttempt: (error) => {
					this.logger.error(
						`Attempt ${error.attemptNumber} installing app ${appId} failed. ` +
							`${error.retriesLeft} retries left.`,
						error,
					)
				},
				retries: 2,
			},
		)

		// Wait for deployment(s) to be ready
		try {
			await this.kubectlNs(
				'wait',
				'--for=condition=available',
				`deployment`,
				'-l', `app=${appId}`,
				'--timeout=300s',
			)
		} catch (error) {
			this.logger.error(`App ${appId} deployment not ready within timeout`, error)
			// Continue anyway - app may still be starting
		}

		this.logger.log(`App ${appId} installed`)
	}

	async uninstallApp(appId: string): Promise<void> {
		this.logger.log(`Uninstalling app ${appId}...`)

		// Delete all resources with the app label
		try {
			await this.kubectlNs(
				'delete',
				'deployment,service,configmap,pvc',
				'-l', `app=${appId}`,
			)
		} catch (error) {
			this.logger.error(`Failed to delete resources for app ${appId}`, error)
		}

		this.logger.log(`App ${appId} uninstalled`)
	}

	async startApp(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Starting app ${appId}...`)

		// Get desired replicas from annotation or default to 1
		let replicas = '1'
		try {
			const {stdout} = await this.kubectlNs(
				'get', 'deployment', '-l', `app=${appId}`,
				'-o', `jsonpath={.items[0].metadata.annotations['umbrel\\.io/desired-replicas']}`,
			)
			if (stdout.trim()) replicas = stdout.trim()
		} catch {
			// Use default
		}

		// Scale all deployments for this app
		await pRetry(
			async () => {
				await this.kubectlNs('scale', 'deployment', '-l', `app=${appId}`, `--replicas=${replicas}`)
			},
			{
				onFailedAttempt: (error) => {
					this.logger.error(
						`Attempt ${error.attemptNumber} starting app ${appId} failed. ` +
							`${error.retriesLeft} retries left.`,
						error,
					)
				},
				retries: 2,
			},
		)

		// Wait for pods to be ready
		try {
			await this.kubectlNs(
				'wait',
				'--for=condition=ready',
				'pod',
				'-l', `app=${appId}`,
				'--timeout=120s',
			)
		} catch (error) {
			this.logger.verbose(`Pods for ${appId} not ready within timeout`)
		}

		this.logger.log(`App ${appId} started`)
	}

	async stopApp(appId: string, options?: StopAppOptions): Promise<void> {
		this.logger.log(`Stopping app ${appId}...`)

		// Store current replica count before scaling down
		try {
			const {stdout} = await this.kubectlNs(
				'get', 'deployment', '-l', `app=${appId}`,
				'-o', `jsonpath={.items[0].spec.replicas}`,
			)
			const currentReplicas = stdout.trim() || '1'
			
			// Annotate deployments with current replicas
			await this.kubectlNs(
				'annotate', 'deployment', '-l', `app=${appId}`,
				`umbrel.io/desired-replicas=${currentReplicas}`,
				'--overwrite',
			)
		} catch {
			// Continue anyway
		}

		// Scale to 0
		await pRetry(
			async () => {
				await this.kubectlNs('scale', 'deployment', '-l', `app=${appId}`, '--replicas=0')
			},
			{
				onFailedAttempt: (error) => {
					this.logger.error(
						`Attempt ${error.attemptNumber} stopping app ${appId} failed. ` +
							`${error.retriesLeft} retries left.`,
						error,
					)
				},
				retries: 2,
			},
		)

		// Wait for pods to terminate
		try {
			await this.kubectlNs(
				'wait',
				'--for=delete',
				'pod',
				'-l', `app=${appId}`,
				'--timeout=60s',
			)
		} catch {
			// Pods may already be gone
		}

		this.logger.log(`App ${appId} stopped`)
	}

	async restartApp(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Restarting app ${appId}...`)

		// Rolling restart
		await this.kubectlNs('rollout', 'restart', 'deployment', '-l', `app=${appId}`)

		// Wait for rollout to complete
		try {
			// Get deployment names
			const {stdout} = await this.kubectlNs(
				'get', 'deployment', '-l', `app=${appId}`,
				'-o', 'jsonpath={.items[*].metadata.name}',
			)
			const deployments = stdout.trim().split(' ').filter(Boolean)

			for (const deployment of deployments) {
				await this.kubectlNs('rollout', 'status', `deployment/${deployment}`, '--timeout=300s')
			}
		} catch (error) {
			this.logger.verbose(`Rollout for ${appId} not complete within timeout`)
		}

		this.logger.log(`App ${appId} restarted`)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Update Operations
	// ─────────────────────────────────────────────────────────────────────────

	async prePatchUpdate(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Pre-patch update for app ${appId}...`)
		// Stop the app before updating manifests
		await this.stopApp(appId)
	}

	async postPatchUpdate(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Post-patch update for app ${appId}...`)

		// Regenerate manifests and apply
		const manifestsDir = await this.generateManifests(appId, dataDir)
		await this.kubectl('apply', '-f', manifestsDir, '-n', this.namespace)

		// Start the app
		await this.startApp(appId, dataDir)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Image Management
	// ─────────────────────────────────────────────────────────────────────────

	async pullImages(images: string[], onProgress?: (progress: number) => void): Promise<void> {
		this.logger.log(`Pulling ${images.length} images...`)

		// In Kubernetes, images are pulled by kubelet when pods are scheduled.
		// We can pre-pull using crictl on nodes, but for simplicity we'll let
		// Kubernetes handle it during pod creation.

		// For now, just report progress
		let completed = 0
		for (const image of images) {
			this.logger.verbose(`Image ${image} will be pulled by Kubernetes when needed`)
			completed++
			onProgress?.(completed / images.length)
		}

		this.logger.log('Image pull preparation complete')
	}

	async removeImages(images: string[]): Promise<void> {
		this.logger.log(`Removing ${images.length} images...`)

		// In Kubernetes, image cleanup is typically handled by kubelet garbage collection.
		// We can use crictl on nodes, but that requires node access.
		// For now, we'll skip direct image removal - kubelet will clean up unused images.

		this.logger.verbose('Image removal delegated to Kubernetes garbage collection')
	}

	async loadImages(paths: string[]): Promise<void> {
		this.logger.log(`Loading ${paths.length} local images...`)

		// In K3s, we can import images using ctr (containerd CLI)
		for (const imagePath of paths) {
			try {
				this.logger.log(`Loading image from ${imagePath}`)
				// K3s uses containerd, so we use ctr to import
				await $`sudo ctr --address /run/k3s/containerd/containerd.sock images import ${imagePath}`
			} catch (error) {
				this.logger.error(`Failed to load image from ${imagePath}`, error)
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Introspection
	// ─────────────────────────────────────────────────────────────────────────

	async getAppLogs(appId: string, lines: number = 500): Promise<string> {
		try {
			const {stdout} = await this.kubectlNs(
				'logs',
				'-l', `app=${appId}`,
				'--all-containers',
				`--tail=${lines}`,
				'--timestamps',
			)
			return stripAnsi(stdout)
		} catch (error) {
			this.logger.error(`Failed to get logs for app ${appId}`, error)
			return ''
		}
	}

	async getAppPids(appId: string): Promise<number[]> {
		// PIDs are not meaningful in Kubernetes (containers run across nodes)
		// Return empty array as documented in the interface
		return []
	}

	async getServiceIp(appId: string, service: string): Promise<string> {
		const serviceName = `${appId}-${service}`

		try {
			// Get ClusterIP of the service
			const {stdout} = await this.kubectlNs(
				'get', 'service', serviceName,
				'-o', `jsonpath={.spec.clusterIP}`,
			)
			return stdout.trim()
		} catch (error) {
			this.logger.error(`Failed to get IP for service ${serviceName}`, error)

			// Fallback: try to get pod IP
			try {
				const {stdout} = await this.kubectlNs(
					'get', 'pods',
					'-l', `app=${appId},component=${service}`,
					'-o', `jsonpath={.items[0].status.podIP}`,
				)
				return stdout.trim()
			} catch {
				throw new Error(`Cannot get IP for service ${serviceName}`)
			}
		}
	}

	async getServiceEndpoint(appId: string, service: string): Promise<ServiceEndpoint> {
		const serviceName = `${appId}-${service}`

		try {
			const {stdout} = await this.kubectlNs(
				'get', 'service', serviceName,
				'-o', 'json',
			)
			const svc = JSON.parse(stdout)

			const port = svc.spec.ports?.[0]?.port ?? 80
			const ip = svc.spec.clusterIP

			return {
				hostname: `${serviceName}.${this.namespace}.svc.cluster.local`,
				port,
				protocol: 'http',
				internalIp: ip,
			}
		} catch (error) {
			this.logger.error(`Failed to get endpoint for service ${serviceName}`, error)
			throw error
		}
	}

	async getAppStatus(appId: string): Promise<AppStatus> {
		try {
			// Check if any deployments exist for this app
			const {stdout: deploymentsJson} = await this.kubectlNs(
				'get', 'deployments',
				'-l', `app=${appId}`,
				'-o', 'json',
			)
			const deployments = JSON.parse(deploymentsJson)

			if (!deployments.items || deployments.items.length === 0) {
				return {
					installed: false,
					running: false,
					services: [],
				}
			}

			// Get pod status for service details
			const {stdout: podsJson} = await this.kubectlNs(
				'get', 'pods',
				'-l', `app=${appId}`,
				'-o', 'json',
			)
			const pods = JSON.parse(podsJson)

			const services: ServiceStatus[] = []
			let allRunning = true

			for (const pod of pods.items || []) {
				for (const container of pod.status?.containerStatuses ?? []) {
					const running = container.state?.running !== undefined
					services.push({
						name: container.name,
						running,
						restartCount: container.restartCount ?? 0,
						ready: container.ready ?? false,
						health: container.ready ? 'healthy' : running ? 'starting' : 'unhealthy',
					})
					if (!running) allRunning = false
				}
			}

			// Check deployments for available replicas
			for (const deployment of deployments.items) {
				const available = deployment.status?.availableReplicas ?? 0
				const desired = deployment.spec?.replicas ?? 1
				if (available < desired) allRunning = false
			}

			return {
				installed: true,
				running: allRunning,
				services,
			}
		} catch (error) {
			this.logger.error(`Failed to get status for app ${appId}`, error)
			return {
				installed: false,
				running: false,
				services: [],
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Configuration
	// ─────────────────────────────────────────────────────────────────────────

	async patchAppConfig(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Patching config for app ${appId}...`)

		// For K8s, we regenerate manifests with any needed patches
		// The patches are applied during manifest generation

		// Read app manifest to check for special requirements
		try {
			const manifestPath = `${dataDir}/umbrel-app.yml`
			if (await fse.pathExists(manifestPath)) {
				const manifest = yaml.load(await fse.readFile(manifestPath, 'utf8')) as any

				// Check for GPU requirements
				if (manifest.permissions?.includes('GPU')) {
					this.logger.verbose(`App ${appId} requires GPU - adding node selector`)
					// TODO: Add node selector for GPU nodes
				}
			}
		} catch (error) {
			this.logger.verbose(`Could not read manifest for ${appId}`, error)
		}

		// Regenerate manifests with patches applied
		await this.generateManifests(appId, dataDir)

		this.logger.log(`Config patched for app ${appId}`)
	}

	async readAppConfig(dataDir: string): Promise<unknown> {
		const composeFile = `${dataDir}/docker-compose.yml`
		const content = await fse.readFile(composeFile, 'utf8')
		return yaml.load(content)
	}

	async writeAppConfig(dataDir: string, config: unknown): Promise<void> {
		const composeFile = `${dataDir}/docker-compose.yml`
		await fse.writeFile(composeFile, yaml.dump(config))
	}
}
