/**
 * Test script for KubernetesRuntime
 * 
 * This script tests the KubernetesRuntime by:
 * 1. Starting the environment (creating namespace)
 * 2. Installing a test app (nginx + redis)
 * 3. Checking app status
 * 4. Getting logs
 * 5. Testing start/stop/restart
 */

import {KubernetesRuntime} from './packages/umbreld/source/modules/apps/container-runtime/kubernetes/index.js'

const KUBECONFIG = '/tmp/umbrel-test/kubeconfig'
const DATA_DIR = '/tmp/umbrel-test'
const APP_ID = 'test-app'
const APP_DATA_DIR = `${DATA_DIR}/app-data/${APP_ID}`

async function main() {
	console.log('='.repeat(60))
	console.log('KubernetesRuntime Test')
	console.log('='.repeat(60))

	// Create runtime with kind cluster config
	const runtime = new KubernetesRuntime({
		type: 'kubernetes',
		dataDirectory: DATA_DIR,
		kubeconfig: KUBECONFIG,
		namespace: 'umbrel',
		storageClass: 'standard', // kind uses 'standard' not 'local-path'
		umbreld: {
			logger: {
				createChildLogger: (name: string) => ({
					log: (...args: any[]) => console.log(`[${name}]`, ...args),
					error: (...args: any[]) => console.error(`[${name}]`, ...args),
					verbose: (...args: any[]) => console.log(`[${name}][verbose]`, ...args),
				}),
			},
		},
	})

	try {
		// Step 1: Start environment
		console.log('\n--- Step 1: Starting Environment ---')
		await runtime.startEnvironment()
		console.log('✓ Environment started')

		// Step 2: Install app
		console.log('\n--- Step 2: Installing App ---')
		await runtime.installApp(APP_ID, APP_DATA_DIR)
		console.log('✓ App installed')

		// Step 3: Check status
		console.log('\n--- Step 3: Checking Status ---')
		const status = await runtime.getAppStatus(APP_ID)
		console.log('Status:', JSON.stringify(status, null, 2))

		// Step 4: Get logs
		console.log('\n--- Step 4: Getting Logs ---')
		const logs = await runtime.getAppLogs(APP_ID, 10)
		console.log('Logs (last 10 lines):\n', logs || '(no logs yet)')

		// Step 5: Get service IP
		console.log('\n--- Step 5: Getting Service IPs ---')
		try {
			const webIp = await runtime.getServiceIp(APP_ID, 'web')
			console.log(`web service IP: ${webIp}`)
		} catch (e) {
			console.log('web service IP: (not available yet)')
		}

		// Step 6: Test stop
		console.log('\n--- Step 6: Testing Stop ---')
		await runtime.stopApp(APP_ID)
		console.log('✓ App stopped')

		const statusAfterStop = await runtime.getAppStatus(APP_ID)
		console.log('Status after stop:', JSON.stringify(statusAfterStop, null, 2))

		// Step 7: Test start
		console.log('\n--- Step 7: Testing Start ---')
		await runtime.startApp(APP_ID, APP_DATA_DIR)
		console.log('✓ App started')

		const statusAfterStart = await runtime.getAppStatus(APP_ID)
		console.log('Status after start:', JSON.stringify(statusAfterStart, null, 2))

		// Step 8: Test restart
		console.log('\n--- Step 8: Testing Restart ---')
		await runtime.restartApp(APP_ID, APP_DATA_DIR)
		console.log('✓ App restarted')

		console.log('\n' + '='.repeat(60))
		console.log('All tests completed successfully!')
		console.log('='.repeat(60))

	} catch (error) {
		console.error('\n❌ Test failed:', error)
		process.exit(1)
	}
}

main()
