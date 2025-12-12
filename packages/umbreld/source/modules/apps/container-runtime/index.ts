/**
 * Container Runtime Abstraction Layer - Factory and Exports
 *
 * This module provides the factory function for creating container runtime
 * instances and exports all public types.
 *
 * @see https://github.com/co-labs-co/umbrel/issues/1
 * @module container-runtime
 */

import type {ContainerRuntime, ContainerRuntimeConfig, RuntimeType} from './types.js'
import {DockerComposeRuntime} from './docker-compose/index.js'
import {KubernetesRuntime} from './kubernetes/index.js'

// Re-export all types
export * from './types.js'

/**
 * Create a container runtime instance based on configuration
 *
 * @param config - Runtime configuration
 * @returns ContainerRuntime instance
 * @throws Error if runtime type is unknown
 *
 * @example
 * ```typescript
 * // Create Docker Compose runtime (default)
 * const runtime = createRuntime({
 *   type: 'docker-compose',
 *   dataDirectory: '/data/umbrel',
 *   umbreld: umbreldInstance,
 * });
 *
 * // Create Kubernetes runtime
 * const k8sRuntime = createRuntime({
 *   type: 'kubernetes',
 *   dataDirectory: '/data/umbrel',
 *   umbreld: umbreldInstance,
 *   namespace: 'umbrel',
 *   storageClass: 'local-path',
 * });
 * ```
 */
export function createRuntime(config: ContainerRuntimeConfig): ContainerRuntime {
	switch (config.type) {
		case 'docker-compose':
			return new DockerComposeRuntime(config)

		case 'kubernetes':
			return new KubernetesRuntime(config)

		default:
			throw new Error(`Unknown container runtime type: ${(config as ContainerRuntimeConfig).type}`)
	}
}

/**
 * Get the default runtime type based on environment
 *
 * Currently always returns 'docker-compose'. In the future, this could
 * detect if running in a Kubernetes cluster and return 'kubernetes'.
 *
 * @returns Default runtime type
 */
export function getDefaultRuntimeType(): RuntimeType {
	// Future: Could detect Kubernetes environment
	// if (process.env.KUBERNETES_SERVICE_HOST) return 'kubernetes';

	return 'docker-compose'
}

/**
 * Check if a runtime type is supported
 *
 * @param type - Runtime type to check
 * @returns true if supported
 */
export function isRuntimeSupported(type: RuntimeType): boolean {
	const supportedRuntimes: RuntimeType[] = [
		'docker-compose',
		'kubernetes',
	]

	return supportedRuntimes.includes(type)
}
