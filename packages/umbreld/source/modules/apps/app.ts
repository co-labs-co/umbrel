import crypto from 'node:crypto'
import nodePath from 'node:path'

import fse from 'fs-extra'
import yaml from 'js-yaml'
import {type Compose} from 'compose-spec-schema'
import fetch from 'node-fetch'
import pRetry from 'p-retry'

import getDirectorySize from '../utilities/get-directory-size.js'
import FileStore from '../utilities/file-store.js'
import {fillSelectedDependencies} from '../utilities/dependencies.js'
import type Umbreld from '../../index.js'
import {validateManifest, type AppSettings} from './schema.js'
import type {ContainerRuntime} from './container-runtime/index.js'

async function readYaml(path: string) {
	return yaml.load(await fse.readFile(path, 'utf8'))
}

async function writeYaml(path: string, data: any) {
	return fse.writeFile(path, yaml.dump(data))
}

export async function readManifestInDirectory(dataDirectory: string) {
	const parseYaml = readYaml(`${dataDirectory}/umbrel-app.yml`)
	return parseYaml.then(validateManifest)
}

type AppState =
	| 'unknown'
	| 'installing'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'stopped'
	| 'restarting'
	| 'uninstalling'
	| 'updating'
	| 'ready'
// TODO: Change ready to running.
// Also note that we don't currently handle failing events to update the app state into a failed state.
// That should be ok for now since apps rarely fail, but there will be the potential for state bugs here
// where the app instance state gets out of sync with the actual state of the app.
// We can handle this much more robustly in the future.

export default class App {
	#umbreld: Umbreld
	#runtime: ContainerRuntime
	logger: Umbreld['logger']
	id: string
	dataDirectory: string
	state: AppState = 'unknown'
	stateProgress = 0
	store: FileStore<AppSettings>

	constructor(umbreld: Umbreld, appId: string, runtime: ContainerRuntime) {
		// Throw on invalid appId
		if (!/^[a-zA-Z0-9-_]+$/.test(appId)) throw new Error(`Invalid app ID: ${appId}`)

		this.#umbreld = umbreld
		this.#runtime = runtime
		this.id = appId
		this.dataDirectory = `${umbreld.dataDirectory}/app-data/${this.id}`
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(name.toLowerCase())
		this.store = new FileStore({filePath: `${this.dataDirectory}/settings.yml`})
	}

	readManifest() {
		return readManifestInDirectory(this.dataDirectory)
	}

	readCompose() {
		return readYaml(`${this.dataDirectory}/docker-compose.yml`) as Promise<Compose>
	}

	async readHiddenService() {
		try {
			return await fse.readFile(`${this.#umbreld.dataDirectory}/tor/data/app-${this.id}/hostname`, 'utf-8')
		} catch (error) {
			this.logger.error(`Failed to read hidden service for app ${this.id}`, error)
			return ''
		}
	}

	async deriveDeterministicPassword() {
		const umbrelSeed = await fse.readFile(`${this.#umbreld.dataDirectory}/db/umbrel-seed/seed`)
		const identifier = `app-${this.id}-seed-APP_PASSWORD`
		const deterministicPassword = crypto.createHmac('sha256', umbrelSeed).update(identifier).digest('hex')

		return deterministicPassword
	}

	writeCompose(compose: Compose) {
		return writeYaml(`${this.dataDirectory}/docker-compose.yml`, compose)
	}

	async patchComposeFile() {
		// Delegate to runtime for config patching
		// This handles container naming, volume migrations, GPU passthrough, etc.
		await this.#runtime.patchAppConfig(this.id, this.dataDirectory)
	}

	async pull() {
		const defaultImages = [
			'getumbrel/app-proxy:1.0.0@sha256:49eb600c4667c4b948055e33171b42a509b7e0894a77e0ca40df8284c77b52fb',
			'getumbrel/tor:0.4.7.8@sha256:2ace83f22501f58857fa9b403009f595137fa2e7986c4fda79d82a8119072b6a',
		]
		const compose = await this.readCompose()
		const images = Object.values(compose.services!)
			.map((service) => service.image)
			.filter(Boolean) as string[]

		// Use runtime to pull images with progress tracking
		await this.#runtime.pullImages([...defaultImages, ...images], (progress) => {
			this.stateProgress = Math.max(1, progress * 99)
			this.logger.log(`Downloaded ${this.stateProgress}% of app ${this.id}`)
		})
	}

	async install() {
		this.state = 'installing'
		this.stateProgress = 1

		await this.patchComposeFile()
		await this.pull()

		// Use runtime to install the app (retries are handled by runtime)
		await this.#runtime.installApp(this.id, this.dataDirectory)

		this.state = 'ready'
		this.stateProgress = 0

		return true
	}

	async update() {
		this.state = 'updating'
		this.stateProgress = 1

		// TODO: Pull images here before the install script and calculate live progress for
		// this.stateProgress so button animations work

		this.logger.log(`Updating app ${this.id}`)

		// Get a reference to the old images
		const compose = await this.readCompose()
		const oldImages = Object.values(compose.services!)
			.map((service) => service.image)
			.filter(Boolean) as string[]

		// Update the app via runtime, patching the compose file half way through
		await this.#runtime.prePatchUpdate(this.id, this.dataDirectory)
		await this.patchComposeFile()
		await this.pull()
		await this.#runtime.postPatchUpdate(this.id, this.dataDirectory)

		// Delete the old images via runtime (silently fails if in use)
		await this.#runtime.removeImages(oldImages)

		this.state = 'ready'
		this.stateProgress = 0

		// Enable auto-start on boot
		await this.setAutoStart(true)

		return true
	}

	async start() {
		this.logger.log(`Starting app ${this.id}`)
		this.state = 'starting'
		// We re-run the patch here to fix an edge case where 0.5.x imported apps
		// wont run because they haven't been patched.
		await this.patchComposeFile()

		// Use runtime to start the app (retries are handled by runtime)
		await this.#runtime.startApp(this.id, this.dataDirectory)

		this.state = 'ready'

		// Enable auto-start on boot
		await this.setAutoStart(true)

		return true
	}

	async stop({persistState = false}: {persistState?: boolean} = {}) {
		this.state = 'stopping'

		// Use runtime to stop the app (retries are handled by runtime)
		await this.#runtime.stopApp(this.id, {persistState})

		this.state = 'stopped'

		// Disable auto-start on boot
		if (persistState) {
			await this.setAutoStart(false)
		}

		return true
	}

	async restart() {
		this.state = 'restarting'

		// Use runtime to restart the app
		await this.#runtime.restartApp(this.id, this.dataDirectory)

		this.state = 'ready'

		// Enable auto-start on boot
		await this.setAutoStart(true)

		return true
	}

	async uninstall() {
		this.state = 'uninstalling'

		// Stop the app first (with retries via runtime)
		await this.#runtime.stopApp(this.id)

		// Remove images via runtime
		await this.#runtime.uninstallApp(this.id)

		// Remove app data directory (not handled by runtime)
		await fse.remove(this.dataDirectory)

		await this.#umbreld.store.getWriteLock(async ({get, set}) => {
			let apps = (await get('apps')) || []
			apps = apps.filter((appId) => appId !== this.id)
			await set('apps', apps)

			// Remove app from recentlyOpenedApps
			let recentlyOpenedApps = (await get('recentlyOpenedApps')) || []
			recentlyOpenedApps = recentlyOpenedApps.filter((appId) => appId !== this.id)
			await set('recentlyOpenedApps', recentlyOpenedApps)

			// Disable any associated widgets
			let widgets = (await get('widgets')) || []
			widgets = widgets.filter((widget) => !widget.startsWith(`${this.id}:`))
			await set('widgets', widgets)
		})

		return true
	}

	async getPids() {
		try {
			return await this.#runtime.getAppPids(this.id)
		} catch (error) {
			this.logger.error(`Failed to get pids for app ${this.id}`, error)
			return []
		}
	}

	async getDiskUsage() {
		try {
			// Disk usage calculations can fail if the app is rapidly moving files around
			// since files in directories will be listed and then iterated over to have
			// their size summed up. If a file is moved between these two operations it
			// will fail. It happens rarely so simply retrying will catch most cases.
			return await pRetry(() => getDirectorySize(this.dataDirectory), {retries: 2})
		} catch (error) {
			this.logger.error(`Failed to get disk usage for app ${this.id}`, error)
			return 0
		}
	}

	async getLogs() {
		return this.#runtime.getAppLogs(this.id)
	}

	async getContainerIp(service: string) {
		return this.#runtime.getServiceIp(this.id, service)
	}

	// Returns a validated list of paths that should be ignored when backing up the app
	// This allows apps to signal to umbrelOS noncritical high churn or high data files
	// that can be ignored from backups like logs/cache/blockchain data/etc.
	async getBackupIgnoredFilePaths() {
		const manifest = await this.readManifest()
		if (!manifest.backupIgnore) return []

		// Sanitise paths
		const backupIgnore = []
		for (let path of manifest.backupIgnore) {
			// Only allow a limited subset of chars to strip out traversals and other weird stuff we don't want to allow
			// while supporting simple '*' globbing that Kopia understands in .kopiaignore
			// TODO: consider adding other globbing chars like '?' (single-char wildcard) and '**' (recursive wildcard).
			if (!/^[-a-zA-Z0-9._\/*]+$/.test(path)) {
				this.logger.error(`Invalid backupIgnore path ${path} for app ${this.id}, skipping`)
				continue // Skip invalid paths
			}

			// Convert to absolute path and normalise traversals
			path = nodePath.join(this.dataDirectory, path)

			// Ensure path doesn't escape the app's data directory
			if (!path.startsWith(this.dataDirectory)) {
				this.logger.error(`Invalid backupIgnore path ${path} for app ${this.id}, skipping`)
				continue // Skip paths that escape the app's data directory
			}

			// Save the sanitised path
			backupIgnore.push(path)
		}

		return backupIgnore
	}

	// Returns a specific widget's info from an app's manifest
	async getWidgetMetadata(widgetName: string) {
		const manifest = await this.readManifest()
		if (!manifest.widgets) throw new Error(`No widgets found for app ${this.id}`)

		const widgetMetadata = manifest.widgets.find((widget) => widget.id === widgetName)
		if (!widgetMetadata) throw new Error(`Invalid widget ${widgetName} for app ${this.id}`)

		return widgetMetadata
	}

	// Returns a specific widget's data
	async getWidgetData(widgetId: string) {
		// Get widget info from the app's manifest
		const widgetMetadata = await this.getWidgetMetadata(widgetId)

		const url = new URL(`http://${widgetMetadata.endpoint}`)
		const service = url.hostname

		url.hostname = await this.getContainerIp(service)

		try {
			const response = await fetch(url)

			if (!response.ok) throw new Error(`Failed to fetch data from ${url}: ${response.statusText}`)

			const widgetData = (await response.json()) as {[key: string]: any}
			return widgetData
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Failed to fetch data from ${url}: ${error.message}`)
			} else {
				throw new Error(`An unexpected error occured while fetching data from ${url}: ${error}`)
			}
		}
	}

	// Get the app's dependencies with selected dependencies applied
	async getDependencies() {
		const [{dependencies}, selectedDependencies] = await Promise.all([
			this.readManifest(),
			this.getSelectedDependencies(),
		])
		return dependencies?.map((dependencyId) => selectedDependencies?.[dependencyId] ?? dependencyId) ?? []
	}

	// Get the app's selected dependencies
	async getSelectedDependencies() {
		const [{dependencies}, selectedDependencies] = await Promise.all([
			this.readManifest(),
			this.store.get('dependencies'),
		])
		return fillSelectedDependencies(dependencies, selectedDependencies)
	}

	// Set the app's selected dependencies
	async setSelectedDependencies(selectedDependencies: Record<string, string>) {
		const {dependencies} = await this.readManifest()
		const filledSelectedDependencies = fillSelectedDependencies(dependencies, selectedDependencies)
		const success = await this.store.set('dependencies', filledSelectedDependencies)
		if (success) {
			this.restart().catch((error) => {
				this.logger.error(`Failed to restart '${this.id}'`, error)
			})
		}
		return success
	}

	// Check if app is ignored from backups
	async isBackupIgnored() {
		return (await this.store.get('backupIgnore')) || false
	}

	// Set if app is ignored from backups
	async setBackupIgnored(backupIgnore: boolean) {
		return this.store.set('backupIgnore', backupIgnore)
	}

	// Set if app should auto start on boot
	async setAutoStart(autoStart: boolean) {
		return this.store.set('autoStart', autoStart)
	}

	// Get if app should auto start on boot
	async shouldAutoStart() {
		return (await this.store.get('autoStart')) ?? true
	}
}
