import {trpcReact} from '@/trpc/trpc'
import {toast} from 'sonner'

/**
 * Hook for cluster status and management
 */
export function useCluster() {
	const utils = trpcReact.useUtils()

	// Queries
	const isEnabledQ = trpcReact.cluster.isEnabled.useQuery()
	const statusQ = trpcReact.cluster.getStatus.useQuery(undefined, {
		enabled: isEnabledQ.data === true,
		refetchInterval: 10000, // Refresh every 10 seconds
	})
	const nodesQ = trpcReact.cluster.getNodes.useQuery(undefined, {
		enabled: isEnabledQ.data === true,
	})
	const configQ = trpcReact.cluster.getConfig.useQuery(undefined, {
		enabled: isEnabledQ.data === true,
	})

	// Mutations
	const enableMut = trpcReact.cluster.enable.useMutation({
		onSuccess: () => {
			utils.cluster.isEnabled.invalidate()
			utils.cluster.getStatus.invalidate()
			toast.success('Kubernetes cluster enabled')
		},
		onError: (err) => toast.error(err.message),
	})

	const disableMut = trpcReact.cluster.disable.useMutation({
		onSuccess: () => {
			utils.cluster.isEnabled.invalidate()
			utils.cluster.getStatus.invalidate()
			toast.success('Switched to Docker Compose mode')
		},
		onError: (err) => toast.error(err.message),
	})

	const removeNodeMut = trpcReact.cluster.removeNode.useMutation({
		onSuccess: () => {
			utils.cluster.getNodes.invalidate()
			utils.cluster.getStatus.invalidate()
			toast.success('Node removed from cluster')
		},
		onError: (err) => toast.error(err.message),
	})

	const cordonNodeMut = trpcReact.cluster.cordonNode.useMutation({
		onSuccess: () => {
			utils.cluster.getNodes.invalidate()
			toast.success('Node cordoned')
		},
		onError: (err) => toast.error(err.message),
	})

	const uncordonNodeMut = trpcReact.cluster.uncordonNode.useMutation({
		onSuccess: () => {
			utils.cluster.getNodes.invalidate()
			toast.success('Node uncordoned')
		},
		onError: (err) => toast.error(err.message),
	})

	return {
		// State
		isEnabled: isEnabledQ.data ?? false,
		isLoading: isEnabledQ.isLoading,
		status: statusQ.data,
		nodes: nodesQ.data ?? [],
		config: configQ.data,

		// Actions
		enable: enableMut.mutate,
		disable: disableMut.mutate,
		removeNode: removeNodeMut.mutate,
		cordonNode: cordonNodeMut.mutate,
		uncordonNode: uncordonNodeMut.mutate,

		// Loading states
		isEnabling: enableMut.isPending,
		isDisabling: disableMut.isPending,
		isRemovingNode: removeNodeMut.isPending,
	}
}

/**
 * Hook for getting cluster join command
 */
export function useClusterJoinCommand() {
	const joinCommandQ = trpcReact.cluster.getJoinCommand.useQuery(undefined, {
		enabled: false, // Only fetch on demand
		retry: false,
	})

	return {
		joinCommand: joinCommandQ.data,
		isLoading: joinCommandQ.isLoading,
		error: joinCommandQ.error,
		refetch: joinCommandQ.refetch,
	}
}
