import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

import fse from 'fs-extra'
import {$} from 'execa'
import pRetry from 'p-retry'
import semver from 'semver'

import randomToken from '../../modules/utilities/random-token.js'
import type Umbreld from '../../index.js'
import type {AppSettings} from './schema.js'
import App, {readManifestInDirectory} from './app.js'
import type {AppManifest} from './schema.js'
import {fillSelectedDependencies} from '../utilities/dependencies.js'
import {createRuntime, type ContainerRuntime, type ContainerRuntimeConfig} from './container-runtime/index.js'

export default class Apps {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	instances: App[] = []
	isTorBeingToggled = false
	runtime: ContainerRuntime

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(name.toLowerCase())

		// Initialize container runtime
		// In the future, this could be configurable via umbrel.yaml
		const runtimeConfig: ContainerRuntimeConfig = {
			type: 'docker-compose',
			dataDirectory: umbreld.dataDirectory,
			umbreld,
		}
		this.runtime = createRuntime(runtimeConfig)
		this.logger.log(`Initialized container runtime: ${this.runtime.type}`)
	}

	async start() {
		// Set apps to empty array on first start
		if ((await this.#umbreld.store.get('apps')) === undefined) {
			await this.#umbreld.store.set('apps', [])
		}

		// Set torEnabled to false on first start
		if ((await this.#umbreld.store.get('torEnabled')) === undefined) {
			await this.#umbreld.store.set('torEnabled', false)
		}

		// Set recentlyOpenedApps to empty array on first start
		if ((await this.#umbreld.store.get('recentlyOpenedApps')) === undefined) {
			await this.#umbreld.store.set('recentlyOpenedApps', [])
		}

		// Create a random umbrel seed on first start if one doesn't exist.
		// This is only used to determinstically derive app seed, app password
		// and custom app specific environment variables. It's needed to maintain
		// compatibility with legacy apps. In the future we'll migrate to apps
		// storing their own random seed/password/etc inside their own data directory.
		const umbrelSeedFile = `${this.#umbreld.dataDirectory}/db/umbrel-seed/seed`
		if (!(await fse.exists(umbrelSeedFile))) {
			this.logger.log('Creating Umbrel seed')
			await fse.ensureFile(umbrelSeedFile)
			await fse.writeFile(umbrelSeedFile, randomToken(256))
		}

		// Setup bin dir
		try {
			const currentFilename = fileURLToPath(import.meta.url)
			const currentDirname = dirname(currentFilename)
			const binSourcePath = join(currentDirname, 'legacy-compat/bin')
			const binDestPath = `${this.#umbreld.dataDirectory}/bin`
			await fse.mkdirp(binDestPath)
			const bins = await fse.readdir(binSourcePath)
			this.logger.log(`Copying bins to ${binDestPath}`)
			for (const bin of bins) {
				this.logger.log(`Copying ${bin}`)
				const source = join(binSourcePath, bin)
				const dest = join(binDestPath, bin)
				await fse.copyFile(source, dest)
			}
		} catch (error) {
			this.logger.error(`Failed to copy bins`, error)
		}

		// Create app instances with runtime reference
		const appIds = await this.#umbreld.store.get('apps')
		this.instances = appIds.map((appId) => new App(this.#umbreld, appId, this.runtime))

		// Don't save references to any apps that don't have a data directory on
		// startup. This will allow apps that were excluded from backups to be
		// reinstalled when the system is restored. Otherwise they'll have an id
		// entry but no data dir and will be stuck in a `not-running` state.
		const appIdsMissingDataDir: string[] = []
		for (const app of this.instances) {
			const appDataDirectoryExists = await fse.pathExists(app.dataDirectory).catch(() => false)
			if (!appDataDirectoryExists) {
				this.logger.error(`App ${app.id} does not have a data directory, removing from instances`)
				this.instances = this.instances.filter((instanceApp) => instanceApp.id !== app.id)
				appIdsMissingDataDir.push(app.id)
			}
		}

		// Force the app state to starting so users don't get confused.
		// They aren't actually starting yet, we need to make sure the app env is up first.
		// But if that takes a long time users see all their apps listed as not running and
		// get confused.
		for (const app of this.instances) app.state = 'starting'

		// Attempt to pre-load local Docker images via runtime
		try {
			const imagesDir = '/images'
			if (await fse.pathExists(imagesDir)) {
				const images = await fse.readdir(imagesDir)
				const imagePaths = images.map((image) => `${imagesDir}/${image}`)
				this.logger.log(`Pre-loading ${imagePaths.length} local images`)
				await this.runtime.loadImages(imagePaths)
			}
		} catch (error) {
			this.logger.error(`Failed to pre-load local Docker images`, error)
		}

		// Start app environment via runtime
		try {
			try {
				await this.runtime.startEnvironment()
			} catch (error) {
				this.logger.error(`Failed to start app environment`, error)
				this.logger.log('Attempting to clean container state before retrying...')
				await this.runtime.cleanState()
			}
			await pRetry(() => this.runtime.startEnvironment(), {
				onFailedAttempt: (error) => {
					this.logger.error(
						`Attempt ${error.attemptNumber} starting app environment failed. There are ${error.retriesLeft} retries left.`,
						error,
					)
				},
				retries: 2, // This will do exponential backoff for 1s, 2s
			})
		} catch (error) {
			// Log the error but continue to try to bring apps up to make it a less bad failure
			this.logger.error(`Failed to start app environment`, error)
		}

		try {
			// Set permissions for tor data directory
			await $`sudo chown -R 1000:1000 ${this.#umbreld.dataDirectory}/tor`
		} catch (error) {
			this.logger.error(`Failed to set permissions for Tor data directory`, error)
		}

		this.logger.log('Starting apps')
		// Snapshot of currently installed apps (minus apps missing their data directories that will be reinstalled)
		// We start these apps (save Promise), fire reinstalls without awaiting, then await the starts.
		const appsToStart = [...this.instances]
		const startAppsPromise = Promise.all(
			appsToStart.map(async (app) => {
				const shouldStart = await app.shouldAutoStart()
				if (!shouldStart) {
					this.logger.log(`Skipping app ${app.id} (autoStart disabled)`)
					app.state = 'stopped'
					return
				}

				return app.start().catch((error) => {
					// We handle individual errors here to prevent apps start from throwing
					// if a single app fails.
					app.state = 'unknown'
					this.logger.error(`Failed to start app ${app.id}`, error)
				})
			}),
		)

		// If this is the first boot after a backup restore, we kick off reinstalls of any apps that are missing their data directory.
		// e.g., due to restoring a backup where the app was excluded.
		// We fire and forget here so users see apps installing as soon as possible.
		this.reinstallMissingAppsAfterRestore(appIdsMissingDataDir).catch((error) =>
			this.logger.error('Failed to schedule app reinstalls after restore', error),
		)

		// Wait for current installed apps to finish starting
		await startAppsPromise
	}

	private async reinstallMissingAppsAfterRestore(appIds: string[]) {
		// Only run on the first start after a backup restore
		if (!this.#umbreld.isBackupRestoreFirstStart) return

		// If there are no apps to reinstall, return early
		if (appIds.length === 0) return

		this.logger.log(`Detected ${appIds.length} app(s) missing a data directory after restore, reinstalling...`)
		try {
			// Best effort retry to ensure app repositories are pulled before reinstalling
			// app stores are excluded from backups so first boot after recovery won't have them.
			await pRetry(
				async () => {
					await this.#umbreld.appStore.update()
				},
				{
					retries: 3,
					onFailedAttempt: (error) => {
						this.logger.error(
							`Failed to update app store before reinstalls (attempt ${error.attemptNumber}, ${error.retriesLeft} retries left).`,
							error,
						)
					},
				},
			)
		} catch (error) {
			this.logger.error('Exhausted retries updating app store before reinstalls', error)

			// If we fail, we return early because no appstore repos exist and installs will fail
			// We won't retry on a later boot (marker file already deleted).
			return
		}

		for (const appId of appIds) {
			// Fire off all installs in parallel without blocking
			// TODO: Consider adding concurrency limiting for app installs to avoid overwhelming system resources
			this.install(appId).catch((error) => this.logger.error(`Failed to reinstall app ${appId}`, error))
		}
	}

	async stop() {
		this.logger.log('Stopping apps')
		await Promise.all(
			this.instances.map((app) =>
				app.stop().catch((error) => {
					// We handle individual errors here to prevent apps stop from throwing
					// if a single app fails.
					this.logger.error(`Failed to stop app ${app.id}`, error)
				}),
			),
		)

		this.logger.log('Stopping app environment')
		await pRetry(() => this.runtime.stopEnvironment(), {
			onFailedAttempt: (error) => {
				this.logger.error(
					`Attempt ${error.attemptNumber} stopping app environment failed. There are ${error.retriesLeft} retries left.`,
				)
			},
			retries: 2,
		})
	}

	async isInstalled(appId: string) {
		return this.instances.some((app) => app.id === appId)
	}

	getApp(appId: string) {
		const app = this.instances.find((app) => app.id === appId)
		if (!app) throw new Error(`App ${appId} not found`)

		return app
	}

	async install(appId: string, alternatives?: AppSettings['dependencies']) {
		if (await this.isInstalled(appId)) throw new Error(`App ${appId} is already installed`)

		this.logger.log(`Installing app ${appId}`)
		const appTemplatePath = await this.#umbreld.appStore.getAppTemplateFilePath(appId)

		let manifest: AppManifest
		try {
			manifest = await readManifestInDirectory(appTemplatePath)
		} catch {
			throw new Error('App template not found')
		}
		const manifestVersionValid = semver.valid(manifest.manifestVersion)
		if (!manifestVersionValid) {
			throw new Error('App manifest version is invalid')
		}
		const umbrelVersionValid = semver.valid(this.#umbreld.version)
		const manifestVersionIsSupported = !!umbrelVersionValid && semver.lte(manifestVersionValid, umbrelVersionValid)
		if (!manifestVersionIsSupported) {
			throw new Error(`App manifest version not supported`)
		}

		this.logger.log(`Setting up data directory for ${appId}`)
		const appDataDirectory = `${this.#umbreld.dataDirectory}/app-data/${appId}`
		await fse.mkdirp(appDataDirectory)

		// We use rsync to copy to preserve permissions
		await $`rsync --archive --verbose --exclude ".gitkeep" ${appTemplatePath}/. ${appDataDirectory}`

		// Save reference to app instance with runtime
		const app = new App(this.#umbreld, appId, this.runtime)
		const filledSelectedDependencies = fillSelectedDependencies(manifest.dependencies, alternatives)
		await app.store.set('dependencies', filledSelectedDependencies)
		this.instances.push(app)

		// Complete the install process via the runtime
		try {
			// We quickly try to start the app env before installing the app. In most normal cases
			// this just quickly returns and does nothing since the app env is already running.
			// However in the case where the app env is down this ensures we start it again.
			await this.runtime.startEnvironment()
			await app.install()
		} catch (error) {
			this.logger.error(`Failed to install app ${appId}`, error)
			this.instances = this.instances.filter((app) => app.id !== appId)
			return false
		}

		// Save installed app
		await this.#umbreld.store.getWriteLock(async ({get, set}) => {
			let apps = await get('apps')
			apps.push(appId)
			// Make sure we never add dupes
			// This can happen after restoring a backup with an excluded app and then reinstalling it
			apps = [...new Set(apps)]
			await set('apps', apps)
		})

		return true
	}

	async uninstall(appId: string) {
		// If we can't read an app's dependencies for any reason just skip that app, don't abort the uninstall
		const allDependencies = await Promise.all(this.instances.map((app) => app.getDependencies().catch(() => null)))
		const isDependency = allDependencies.some((dependencies) => dependencies?.includes(appId))
		if (isDependency) throw new Error(`App ${appId} is a dependency of another app and cannot be uninstalled`)

		const app = this.getApp(appId)

		const uninstalled = await app.uninstall()
		if (uninstalled) {
			// Remove app instance
			this.instances = this.instances.filter((app) => app.id !== appId)
		}
		return uninstalled
	}

	async restart(appId: string) {
		const app = this.getApp(appId)

		return app.restart()
	}

	async update(appId: string) {
		const app = this.getApp(appId)

		return app.update()
	}

	async trackOpen(appId: string) {
		const app = this.getApp(appId)

		// Save installed app
		await this.#umbreld.store.getWriteLock(async ({get, set}) => {
			let recentlyOpenedApps = await get('recentlyOpenedApps')

			// Add app.id to the beginning of the array
			recentlyOpenedApps.unshift(app.id)

			// Remove duplicates
			recentlyOpenedApps = [...new Set(recentlyOpenedApps)]

			// Limit to 10
			recentlyOpenedApps = recentlyOpenedApps.slice(0, 10)

			await set('recentlyOpenedApps', recentlyOpenedApps)
		})

		return true
	}

	async recentlyOpened() {
		return this.#umbreld.store.get('recentlyOpenedApps')
	}

	async setTorEnabled(torEnabled: boolean) {
		if (this.isTorBeingToggled) {
			throw new Error(
				'Tor is already in the process of being toggled. Please wait until the current process is finished.',
			)
		}
		this.isTorBeingToggled = true
		try {
			const currentTorEnabled = await this.#umbreld.store.get('torEnabled')

			// Check if we're applying the current setting
			if (currentTorEnabled === torEnabled) {
				throw new Error(`Tor is already ${torEnabled ? 'enabled' : 'disabled'}`)
			}

			// Toggle Tor
			await this.stop()
			await this.#umbreld.store.set('torEnabled', torEnabled)
			await this.start()

			return true
		} finally {
			this.isTorBeingToggled = false
		}
	}

	async getTorEnabled() {
		return this.#umbreld.store.get('torEnabled')
	}

	async setSelectedDependencies(appId: string, dependencies: Record<string, string>) {
		const app = this.getApp(appId)
		return app.setSelectedDependencies(dependencies)
	}

	async getDependents(appId: string) {
		const allDependencies = await Promise.all(
			this.instances.map(async (app) => ({
				id: app.id,
				// If we can't read an app's dependencies for any reason just skip that app, don't abort
				dependencies: await app.getDependencies().catch(() => [] as string[]),
			})),
		)
		return allDependencies.filter(({dependencies}) => dependencies.includes(appId)).map(({id}) => id)
	}

	async setHideCredentialsBeforeOpen(appId: string, value: boolean) {
		const app = this.getApp(appId)
		return app.store.set('hideCredentialsBeforeOpen', value)
	}
}
