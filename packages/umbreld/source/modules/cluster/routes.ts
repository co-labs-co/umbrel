/**
 * Cluster Management tRPC Routes
 *
 * Provides API endpoints for cluster status, node management, and configuration.
 *
 * @module cluster/routes
 */

import {z} from 'zod'
import {TRPCError} from '@trpc/server'

import {router, privateProcedure} from '../server/trpc/trpc.js'

export default router({
	/**
	 * Check if Kubernetes cluster mode is enabled
	 */
	isEnabled: privateProcedure.query(async ({ctx}) => {
		return ctx.umbreld.cluster.isEnabled()
	}),

	/**
	 * Get cluster status including node count, health, and resources
	 */
	getStatus: privateProcedure.query(async ({ctx}) => {
		return ctx.umbreld.cluster.getStatus()
	}),

	/**
	 * Get all cluster nodes
	 */
	getNodes: privateProcedure.query(async ({ctx}) => {
		return ctx.umbreld.cluster.getNodes()
	}),

	/**
	 * Get specific node details
	 */
	getNode: privateProcedure
		.input(z.object({name: z.string()}))
		.query(async ({ctx, input}) => {
			const node = await ctx.umbreld.cluster.getNode(input.name)
			if (!node) {
				throw new TRPCError({code: 'NOT_FOUND', message: `Node ${input.name} not found`})
			}
			return node
		}),

	/**
	 * Get cluster configuration
	 */
	getConfig: privateProcedure.query(async ({ctx}) => {
		return ctx.umbreld.cluster.getConfig()
	}),

	/**
	 * Generate join command for adding worker nodes
	 */
	getJoinCommand: privateProcedure.query(async ({ctx}) => {
		const enabled = await ctx.umbreld.cluster.isEnabled()
		if (!enabled) {
			throw new TRPCError({code: 'PRECONDITION_FAILED', message: 'Kubernetes is not enabled'})
		}
		return ctx.umbreld.cluster.getJoinCommand()
	}),

	/**
	 * Remove a node from the cluster
	 */
	removeNode: privateProcedure
		.input(z.object({name: z.string()}))
		.mutation(async ({ctx, input}) => {
			const enabled = await ctx.umbreld.cluster.isEnabled()
			if (!enabled) {
				throw new TRPCError({code: 'PRECONDITION_FAILED', message: 'Kubernetes is not enabled'})
			}
			return ctx.umbreld.cluster.removeNode(input.name)
		}),

	/**
	 * Cordon a node (mark as unschedulable)
	 */
	cordonNode: privateProcedure
		.input(z.object({name: z.string()}))
		.mutation(async ({ctx, input}) => {
			const enabled = await ctx.umbreld.cluster.isEnabled()
			if (!enabled) {
				throw new TRPCError({code: 'PRECONDITION_FAILED', message: 'Kubernetes is not enabled'})
			}
			return ctx.umbreld.cluster.cordonNode(input.name)
		}),

	/**
	 * Uncordon a node (mark as schedulable)
	 */
	uncordonNode: privateProcedure
		.input(z.object({name: z.string()}))
		.mutation(async ({ctx, input}) => {
			const enabled = await ctx.umbreld.cluster.isEnabled()
			if (!enabled) {
				throw new TRPCError({code: 'PRECONDITION_FAILED', message: 'Kubernetes is not enabled'})
			}
			return ctx.umbreld.cluster.uncordonNode(input.name)
		}),

	/**
	 * Enable Kubernetes runtime
	 */
	enable: privateProcedure
		.input(z.object({kubeconfig: z.string().optional()}))
		.mutation(async ({ctx, input}) => {
			return ctx.umbreld.cluster.enable(input.kubeconfig)
		}),

	/**
	 * Disable Kubernetes runtime (switch back to Docker Compose)
	 */
	disable: privateProcedure.mutation(async ({ctx}) => {
		return ctx.umbreld.cluster.disable()
	}),
})
