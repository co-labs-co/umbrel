/**
 * Container Runtime Abstraction Layer - Type Definitions
 *
 * This module provides a pluggable interface for container orchestration,
 * allowing Umbrel to support both Docker Compose (current) and Kubernetes (future).
 *
 * @see https://github.com/co-labs-co/umbrel/issues/1
 * @module container-runtime/types
 */

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported container runtime types
 */
export type RuntimeType = 'docker-compose' | 'kubernetes'

/**
 * Configuration for container runtime initialization
 */
export interface ContainerRuntimeConfig {
	/** Runtime type to use */
	type: RuntimeType

	/** Base data directory for Umbrel */
	dataDirectory: string

	/** Reference to the Umbreld instance (for accessing stores, server, etc.) */
	// Using 'any' here to avoid circular dependency - will be typed as Umbreld
	umbreld: any

	// ─────────────────────────────────────────────────────────────────────────
	// Docker Compose specific options
	// ─────────────────────────────────────────────────────────────────────────

	/** Docker network subnet (default: "10.21.0.0/16") */
	networkSubnet?: string

	// ─────────────────────────────────────────────────────────────────────────
	// Kubernetes specific options (Phase 2)
	// ─────────────────────────────────────────────────────────────────────────

	/** Path to kubeconfig file */
	kubeconfig?: string

	/** Kubernetes namespace for Umbrel apps (default: "umbrel") */
	namespace?: string

	/** Storage class for PersistentVolumeClaims (default: "local-path") */
	storageClass?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// App Lifecycle Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for app installation
 */
export interface InstallAppOptions {
	/** Whether Tor hidden services are enabled */
	torEnabled?: boolean

	/** Skip starting the app after installation */
	skipStart?: boolean
}

/**
 * Options for stopping an app
 */
export interface StopAppOptions {
	/** Whether to persist the stopped state (disable auto-start) */
	persistState?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Health status of a service
 */
export type ServiceHealth = 'healthy' | 'unhealthy' | 'starting' | 'unknown'

/**
 * Status of an individual service within an app
 */
export interface ServiceStatus {
	/** Service name */
	name: string

	/** Whether the service is currently running */
	running: boolean

	/** Number of times the service has restarted */
	restartCount: number

	/** Whether the service is ready to accept traffic */
	ready: boolean

	/** Health check status (if configured) */
	health?: ServiceHealth
}

/**
 * Overall status of an app
 */
export interface AppStatus {
	/** Whether the app is installed */
	installed: boolean

	/** Whether all services are running */
	running: boolean

	/** Status of individual services */
	services: ServiceStatus[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Networking Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Protocol for service endpoints
 */
export type EndpointProtocol = 'http' | 'https' | 'tcp' | 'udp'

/**
 * Service endpoint information for accessing an app service
 */
export interface ServiceEndpoint {
	/** Hostname to access the service */
	hostname: string

	/** Port number */
	port: number

	/** Protocol */
	protocol: EndpointProtocol

	/**
	 * Internal IP address (Docker Compose only)
	 * In Kubernetes, services are accessed via DNS, not IP
	 */
	internalIp?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Container Runtime Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ContainerRuntime - Pluggable interface for container orchestration
 *
 * This interface abstracts container runtime operations, allowing Umbrel
 * to support multiple orchestration backends (Docker Compose, Kubernetes).
 *
 * Implementations:
 * - DockerComposeRuntime: Wraps existing Docker Compose + bash script logic
 * - KubernetesRuntime: K3s + kubectl/Helm (Phase 2)
 *
 * @example
 * ```typescript
 * const runtime = createRuntime({ type: 'docker-compose', dataDirectory: '/data', umbreld });
 * await runtime.startEnvironment();
 * await runtime.installApp('bitcoin', '/data/app-data/bitcoin');
 * ```
 */
export interface ContainerRuntime {
	/** Runtime type identifier */
	readonly type: RuntimeType

	/** Runtime configuration */
	readonly config: ContainerRuntimeConfig

	// ─────────────────────────────────────────────────────────────────────────
	// Environment Lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Start the container runtime environment (base services)
	 *
	 * Docker Compose: Starts tor_proxy, auth containers via docker-compose up
	 * Kubernetes: Ensures namespace exists, deploys base Helm charts
	 *
	 * @throws Error if environment fails to start
	 */
	startEnvironment(): Promise<void>

	/**
	 * Stop the container runtime environment
	 *
	 * Docker Compose: docker compose down
	 * Kubernetes: Scales deployments to 0 or deletes namespace
	 *
	 * @throws Error if environment fails to stop
	 */
	stopEnvironment(): Promise<void>

	/**
	 * Clean up stale state (crashed containers, orphaned networks)
	 *
	 * Docker Compose: docker stop/rm all containers, docker network prune
	 * Kubernetes: kubectl delete pods --field-selector=status.phase=Failed
	 *
	 * This is typically called after a crash or failed startup to reset state.
	 */
	cleanState(): Promise<void>

	// ─────────────────────────────────────────────────────────────────────────
	// App Lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Install and start an app
	 *
	 * @param appId - Unique app identifier (e.g., "bitcoin", "lightning")
	 * @param dataDir - Path to app's data directory containing docker-compose.yml
	 * @param options - Installation options
	 * @throws Error if installation fails
	 */
	installApp(appId: string, dataDir: string, options?: InstallAppOptions): Promise<void>

	/**
	 * Uninstall an app (stop containers, remove images, cleanup)
	 *
	 * Note: This does NOT delete the app's data directory - that's handled
	 * by the App class.
	 *
	 * @param appId - App identifier
	 * @throws Error if uninstallation fails
	 */
	uninstallApp(appId: string): Promise<void>

	/**
	 * Start a stopped app
	 *
	 * @param appId - App identifier
	 * @param dataDir - Path to app's data directory
	 * @throws Error if app fails to start
	 */
	startApp(appId: string, dataDir: string): Promise<void>

	/**
	 * Stop a running app
	 *
	 * @param appId - App identifier
	 * @param options - Stop options
	 * @throws Error if app fails to stop
	 */
	stopApp(appId: string, options?: StopAppOptions): Promise<void>

	/**
	 * Restart an app (stop + start)
	 *
	 * @param appId - App identifier
	 * @param dataDir - Path to app's data directory
	 * @throws Error if restart fails
	 */
	restartApp(appId: string, dataDir: string): Promise<void>

	// ─────────────────────────────────────────────────────────────────────────
	// Update Operations
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Prepare app for update (pre-patch phase)
	 *
	 * Docker Compose: Stops app, copies new files, applies templates
	 * Kubernetes: Prepares new manifest/chart
	 *
	 * @param appId - App identifier
	 * @param dataDir - Path to app's data directory
	 */
	prePatchUpdate(appId: string, dataDir: string): Promise<void>

	/**
	 * Complete app update (post-patch phase)
	 *
	 * Docker Compose: Pulls new images, starts app
	 * Kubernetes: Applies new manifest/chart, waits for rollout
	 *
	 * @param appId - App identifier
	 * @param dataDir - Path to app's data directory
	 */
	postPatchUpdate(appId: string, dataDir: string): Promise<void>

	// ─────────────────────────────────────────────────────────────────────────
	// Image Management
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Pull container images from registry
	 *
	 * @param images - Array of image references (e.g., ["nginx:latest", "redis:7"])
	 * @param onProgress - Optional progress callback (0-1 range)
	 */
	pullImages(images: string[], onProgress?: (progress: number) => void): Promise<void>

	/**
	 * Remove container images
	 *
	 * Silently fails if images are still in use.
	 *
	 * @param images - Array of image references to remove
	 */
	removeImages(images: string[]): Promise<void>

	/**
	 * Load images from local tar files
	 *
	 * Used for pre-loading images from USB or local storage.
	 *
	 * @param paths - Paths to image tar files
	 */
	loadImages(paths: string[]): Promise<void>

	// ─────────────────────────────────────────────────────────────────────────
	// Introspection
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get app container logs
	 *
	 * @param appId - App identifier
	 * @param lines - Number of lines to retrieve (default: 500)
	 * @returns Combined logs from all app containers
	 */
	getAppLogs(appId: string, lines?: number): Promise<string>

	/**
	 * Get process IDs for app containers
	 *
	 * Docker Compose: Returns PIDs via docker top
	 * Kubernetes: Returns empty array (PIDs not meaningful across nodes)
	 *
	 * @param appId - App identifier
	 * @returns Array of process IDs
	 */
	getAppPids(appId: string): Promise<number[]>

	/**
	 * Get IP address of a service within an app
	 *
	 * Docker Compose: Container IP from docker inspect
	 * Kubernetes: Service ClusterIP or Pod IP
	 *
	 * @param appId - App identifier
	 * @param service - Service name within the app
	 * @returns IP address string
	 */
	getServiceIp(appId: string, service: string): Promise<string>

	/**
	 * Get service endpoint for external access
	 *
	 * @param appId - App identifier
	 * @param service - Service name within the app
	 * @returns Service endpoint information
	 */
	getServiceEndpoint(appId: string, service: string): Promise<ServiceEndpoint>

	/**
	 * Get overall app status
	 *
	 * @param appId - App identifier
	 * @returns App status including all services
	 */
	getAppStatus(appId: string): Promise<AppStatus>

	// ─────────────────────────────────────────────────────────────────────────
	// Configuration
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Apply runtime-specific patches to app configuration
	 *
	 * Docker Compose:
	 * - Force container naming scheme for compatibility
	 * - Migrate volume paths
	 * - Enable GPU passthrough if requested
	 *
	 * Kubernetes:
	 * - Apply resource limits
	 * - Set node selectors/tolerations
	 * - Configure storage classes
	 *
	 * @param appId - App identifier
	 * @param dataDir - Path to app's data directory
	 */
	patchAppConfig(appId: string, dataDir: string): Promise<void>

	/**
	 * Read the compose/manifest file for an app
	 *
	 * Docker Compose: Reads docker-compose.yml
	 * Kubernetes: Reads K8s manifests or Helm values
	 *
	 * @param dataDir - Path to app's data directory
	 * @returns Parsed configuration object
	 */
	readAppConfig(dataDir: string): Promise<unknown>

	/**
	 * Write the compose/manifest file for an app
	 *
	 * @param dataDir - Path to app's data directory
	 * @param config - Configuration object to write
	 */
	writeAppConfig(dataDir: string, config: unknown): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logger interface for runtime implementations
 * Matches Umbreld's logger interface
 */
export interface RuntimeLogger {
	log(message: string, ...args: unknown[]): void
	error(message: string, ...args: unknown[]): void
	verbose(message: string, ...args: unknown[]): void
}
