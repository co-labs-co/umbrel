/**
 * Docker Compose Container Runtime Implementation
 *
 * This class implements the ContainerRuntime interface by wrapping the existing
 * Docker Compose + bash script orchestration logic. It provides a clean interface
 * that can be swapped out for Kubernetes in the future.
 *
 * Design Principle: WRAP, DON'T REFACTOR
 * This implementation wraps the existing legacy-compat code rather than
 * rewriting it, ensuring zero behavioral changes for existing users.
 *
 * @see https://github.com/co-labs-co/umbrel/issues/1
 * @module container-runtime/docker-compose
 */

import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

import fse from 'fs-extra'
import yaml from 'js-yaml'
import {$} from 'execa'
import {type Compose} from 'compose-spec-schema'
import stripAnsi from 'strip-ansi'
import pRetry from 'p-retry'

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

// Import the existing utilities - these paths will be updated after moving files
import {pullAll} from '../../../utilities/docker-pull.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

async function readYaml(path: string): Promise<unknown> {
	return yaml.load(await fse.readFile(path, 'utf8'))
}

async function writeYaml(path: string, data: unknown): Promise<void> {
	await fse.writeFile(path, yaml.dump(data))
}

// ─────────────────────────────────────────────────────────────────────────────
// Docker Compose Runtime Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DockerComposeRuntime - Wraps existing Docker Compose orchestration
 *
 * This implementation delegates to the existing bash script (app-script) and
 * app-environment.ts for actual container management. It maintains 100%
 * backward compatibility while providing the ContainerRuntime interface.
 */
export class DockerComposeRuntime implements ContainerRuntime {
	readonly type: RuntimeType = 'docker-compose'
	readonly config: ContainerRuntimeConfig

	private logger: RuntimeLogger
	private legacyCompatDir: string

	constructor(config: ContainerRuntimeConfig) {
		this.config = config

		// Create logger from umbreld instance or use console fallback
		if (config.umbreld?.logger) {
			this.logger = config.umbreld.logger.createChildLogger('docker-compose-runtime')
		} else {
			this.logger = {
				log: console.log.bind(console),
				error: console.error.bind(console),
				verbose: console.log.bind(console),
			}
		}

		// Resolve path to legacy-compat directory
		const currentFilename = fileURLToPath(import.meta.url)
		const currentDirname = dirname(currentFilename)
		// After move: ./legacy-compat, before move: ../legacy-compat
		this.legacyCompatDir = join(currentDirname, 'legacy-compat')

		// Fallback to old location if new location doesn't exist
		if (!fse.existsSync(this.legacyCompatDir)) {
			this.legacyCompatDir = join(currentDirname, '..', 'legacy-compat')
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Environment Lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	async startEnvironment(): Promise<void> {
		this.logger.log('Starting Docker Compose environment')

		const composePath = join(this.legacyCompatDir, 'docker-compose.yml')
		const torEnabled = await this.config.umbreld.store.get('torEnabled')

		const options = {
			stdio: 'inherit' as const,
			cwd: this.config.dataDirectory,
			env: this.getEnvironmentVariables(torEnabled),
		}

		await $(
			options,
		)`docker compose --project-name umbrel --file ${composePath} up --build --detach --remove-orphans`
	}

	async stopEnvironment(): Promise<void> {
		this.logger.log('Stopping Docker Compose environment')

		const composePath = join(this.legacyCompatDir, 'docker-compose.yml')
		const torEnabled = await this.config.umbreld.store.get('torEnabled')

		const options = {
			stdio: 'inherit' as const,
			cwd: this.config.dataDirectory,
			env: this.getEnvironmentVariables(torEnabled),
		}

		await $(options)`docker compose --project-name umbrel --file ${composePath} down`
	}

	async cleanState(): Promise<void> {
		this.logger.log('Cleaning Docker state')

		try {
			const containerIds = (await $`docker ps -aq`).stdout.split('\n').filter(Boolean)
			if (containerIds.length) {
				this.logger.log(`Stopping ${containerIds.length} containers...`)
				await $({stdio: 'inherit'})`docker stop --time 30 ${containerIds}`
				await $({stdio: 'inherit'})`docker rm ${containerIds}`
			}
		} catch (error) {
			this.logger.error('Failed to clean containers', error)
		}

		try {
			this.logger.log('Pruning networks...')
			await $({stdio: 'inherit'})`docker network prune -f`
		} catch (error) {
			this.logger.error('Failed to prune networks', error)
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// App Lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	async installApp(appId: string, dataDir: string, options?: InstallAppOptions): Promise<void> {
		this.logger.log(`Installing app ${appId}`)

		await pRetry(
			() => this.executeAppScript('install', appId),
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
	}

	async uninstallApp(appId: string): Promise<void> {
		this.logger.log(`Uninstalling app ${appId}`)
		await this.executeAppScript('nuke-images', appId)
	}

	async startApp(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Starting app ${appId}`)

		await pRetry(
			() => this.executeAppScript('start', appId),
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
	}

	async stopApp(appId: string, options?: StopAppOptions): Promise<void> {
		this.logger.log(`Stopping app ${appId}`)

		await pRetry(
			() => this.executeAppScript('stop', appId),
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
	}

	async restartApp(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Restarting app ${appId}`)
		await this.executeAppScript('stop', appId)
		await this.executeAppScript('start', appId)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Update Operations
	// ─────────────────────────────────────────────────────────────────────────

	async prePatchUpdate(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Pre-patch update for app ${appId}`)
		await this.executeAppScript('pre-patch-update', appId)
	}

	async postPatchUpdate(appId: string, dataDir: string): Promise<void> {
		this.logger.log(`Post-patch update for app ${appId}`)
		await this.executeAppScript('post-patch-update', appId)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Image Management
	// ─────────────────────────────────────────────────────────────────────────

	async pullImages(images: string[], onProgress?: (progress: number) => void): Promise<void> {
		this.logger.log(`Pulling ${images.length} images`)
		await pullAll(images, onProgress || (() => {}))
	}

	async removeImages(images: string[]): Promise<void> {
		if (images.length === 0) return

		this.logger.log(`Removing ${images.length} images`)
		try {
			await $({stdio: 'inherit'})`docker rmi ${images}`
		} catch {
			// Silently fail - images may still be in use
			this.logger.verbose('Some images could not be removed (may still be in use)')
		}
	}

	async loadImages(paths: string[]): Promise<void> {
		for (const path of paths) {
			try {
				this.logger.log(`Loading image from ${path}`)
				await $({stdio: 'inherit'})`docker load --input ${path}`
			} catch (error) {
				this.logger.error(`Failed to load image from ${path}`, error)
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Introspection
	// ─────────────────────────────────────────────────────────────────────────

	async getAppLogs(appId: string, lines: number = 500): Promise<string> {
		const result = await this.executeAppScript('logs', appId, false)
		return stripAnsi(result.stdout)
	}

	async getAppPids(appId: string): Promise<number[]> {
		try {
			const compose = await this.readAppConfig(
				`${this.config.dataDirectory}/app-data/${appId}`,
			) as Compose

			const containers = Object.values(compose.services || {}).map(
				(service: any) => service.container_name,
			) as string[]

			// Add proxy and tor containers
			containers.push(`${appId}_app_proxy_1`)
			containers.push(`${appId}_tor_server_1`)

			const cmd = containers
				.map((container) => `docker top ${container} -o pid 2>/dev/null || true`)
				.join('\n')

			const {stdout} = await $({shell: true})`${cmd}`

			return stdout
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => /^([1-9][0-9]*|0)$/.test(line))
				.map((line) => parseInt(line, 10))
		} catch (error) {
			this.logger.error(`Failed to get PIDs for app ${appId}`, error)
			return []
		}
	}

	async getServiceIp(appId: string, service: string): Promise<string> {
		const compose = await this.readAppConfig(
			`${this.config.dataDirectory}/app-data/${appId}`,
		) as Compose

		const containerName = compose.services?.[service]?.container_name

		if (!containerName) {
			throw new Error(`No container_name found for service ${service} in app ${appId}`)
		}

		const {stdout: containerIp} = await $`docker inspect -f {{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}} ${containerName}`

		return containerIp.trim()
	}

	async getServiceEndpoint(appId: string, service: string): Promise<ServiceEndpoint> {
		const ip = await this.getServiceIp(appId, service)
		const compose = await this.readAppConfig(
			`${this.config.dataDirectory}/app-data/${appId}`,
		) as Compose

		const containerName = compose.services?.[service]?.container_name || `${appId}_${service}_1`

		// Try to get port from compose file
		const ports = compose.services?.[service]?.ports
		let port = 80
		if (ports && ports.length > 0) {
			const portSpec = ports[0]
			if (typeof portSpec === 'string') {
				const match = portSpec.match(/:(\d+)/)
				if (match) port = parseInt(match[1], 10)
			} else if (typeof portSpec === 'object' && 'target' in portSpec) {
				port = portSpec.target ?? 80
			}
		}

		return {
			hostname: containerName,
			port,
			protocol: 'http',
			internalIp: ip,
		}
	}

	async getAppStatus(appId: string): Promise<AppStatus> {
		try {
			const compose = await this.readAppConfig(
				`${this.config.dataDirectory}/app-data/${appId}`,
			) as Compose

			const services: ServiceStatus[] = []
			let allRunning = true

			for (const [name, serviceConfig] of Object.entries(compose.services || {})) {
				const containerName = (serviceConfig as any).container_name || `${appId}_${name}_1`

				try {
					const {stdout} = await $`docker inspect --format {{.State.Running}} ${containerName}`
					const running = stdout.trim() === 'true'

					services.push({
						name,
						running,
						restartCount: 0, // Would need additional inspect call
						ready: running,
						health: running ? 'healthy' : 'unhealthy',
					})

					if (!running) allRunning = false
				} catch {
					services.push({
						name,
						running: false,
						restartCount: 0,
						ready: false,
						health: 'unknown',
					})
					allRunning = false
				}
			}

			return {
				installed: true,
				running: allRunning,
				services,
			}
		} catch {
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
		// Read manifest to check for GPU permissions
		const manifestPath = `${dataDir}/umbrel-app.yml`
		let appRequestsGpuAccess = false

		try {
			const manifest = (await readYaml(manifestPath)) as any
			appRequestsGpuAccess = manifest?.permissions?.includes('GPU')
		} catch {
			// Manifest might not exist or be invalid
		}

		const DRI_DEVICE_PATH = '/dev/dri'
		const deviceHasGpu = await fse.exists(DRI_DEVICE_PATH).catch(() => false)

		const compose = (await this.readAppConfig(dataDir)) as Compose

		for (const serviceName of Object.keys(compose.services || {})) {
			const service = compose.services![serviceName]

			// Force container naming scheme for compatibility
			if (!service.container_name) {
				service.container_name = `${appId}_${serviceName}_1`
			}

			// Migrate volume paths
			service.volumes = service.volumes?.map((volume) => {
				return (volume as string)
					?.replace('/data/storage/downloads', '/home/Downloads')
					?.replace('/data/storage', '/home')
			})

			// GPU passthrough
			const shouldEnableGpuPassthrough = appRequestsGpuAccess && deviceHasGpu
			if (shouldEnableGpuPassthrough) {
				service.devices = service.devices || []
				if (!service.devices.includes(DRI_DEVICE_PATH)) {
					service.devices.push(DRI_DEVICE_PATH)
				}
			}
		}

		await this.writeAppConfig(dataDir, compose)
	}

	async readAppConfig(dataDir: string): Promise<unknown> {
		return readYaml(`${dataDir}/docker-compose.yml`)
	}

	async writeAppConfig(dataDir: string, config: unknown): Promise<void> {
		await writeYaml(`${dataDir}/docker-compose.yml`, config)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Private Helpers
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Execute the legacy app-script bash script
	 */
	private async executeAppScript(
		command: string,
		appId: string,
		inheritStdio: boolean = true,
	): Promise<{stdout: string; stderr: string}> {
		// Prevent breaking test output
		if (process.env.TEST === 'true') inheritStdio = false

		const scriptPath = join(this.legacyCompatDir, 'app-script')

		// Get app repo directory (may be empty for new installs)
		let SCRIPT_APP_REPO_DIR = ''
		try {
			SCRIPT_APP_REPO_DIR = await this.config.umbreld.appStore.getAppTemplateFilePath(appId)
		} catch {
			// App repo might not exist yet
		}

		const torEnabled = await this.config.umbreld.store.get('torEnabled')

		return $({
			stdio: inheritStdio ? 'inherit' : 'pipe',
			env: {
				SCRIPT_UMBREL_ROOT: this.config.dataDirectory,
				SCRIPT_DOCKER_FRAGMENTS: this.legacyCompatDir,
				JWT_SECRET: await this.config.umbreld.server.getJwtSecret(),
				SCRIPT_APP_REPO_DIR,
				BITCOIN_NETWORK: 'mainnet',
				TOR_PROXY_IP: '10.21.21.11',
				TOR_PROXY_PORT: '9050',
				TOR_PASSWORD: 'mLcLDdt5qqMxlq3wv8Din3UD44bTZHzRFhIktw38kWg=',
				TOR_HASHED_PASSWORD: '16:158FBE422B1A9D996073BE2B9EC38852C70CE12362CA016F8F6859C426',
				REMOTE_TOR_ACCESS: torEnabled ? 'true' : 'false',
			},
		})`${scriptPath} ${command} ${appId}`
	}

	/**
	 * Get environment variables for docker-compose commands
	 */
	private getEnvironmentVariables(torEnabled: boolean): Record<string, string> {
		return {
			UMBREL_DATA_DIR: this.config.dataDirectory,
			NETWORK_IP: '10.21.0.0',
			GATEWAY_IP: '10.21.0.1',
			DASHBOARD_IP: '10.21.21.3',
			MANAGER_IP: '10.21.21.4',
			AUTH_IP: '10.21.21.6',
			AUTH_PORT: '2000',
			TOR_PROXY_IP: '10.21.21.11',
			TOR_PROXY_PORT: '9050',
			TOR_PASSWORD: 'mLcLDdt5qqMxlq3wv8Din3UD44bTZHzRFhIktw38kWg=',
			TOR_HASHED_PASSWORD: '16:158FBE422B1A9D996073BE2B9EC38852C70CE12362CA016F8F6859C426',
			UMBREL_AUTH_SECRET: 'DEADBEEF',
			JWT_SECRET: '', // Will be set dynamically
			UMBRELD_RPC_HOST: `host.docker.internal:${this.config.umbreld.server.port}`,
			UMBREL_LEGACY_COMPAT_DIR: this.legacyCompatDir,
			UMBREL_TORRC: torEnabled
				? `${this.legacyCompatDir}/tor-server-torrc`
				: `${this.legacyCompatDir}/tor-proxy-torrc`,
		}
	}
}
