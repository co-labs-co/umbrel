import React from 'react'
import {TbServer, TbServerOff, TbPlus, TbTrash, TbPlayerPause, TbPlayerPlay} from 'react-icons/tb'
import {RiNodeTree} from 'react-icons/ri'

import {CopyableField} from '@/components/ui/copyable-field'
import {CoverMessage, CoverMessageParagraph} from '@/components/ui/cover-message'
import {IconButton} from '@/components/ui/icon-button'
import {Loading} from '@/components/ui/loading'
import {useCluster, useClusterJoinCommand} from '@/hooks/use-cluster'
import {useIsMobile} from '@/hooks/use-is-mobile'
import {useSettingsDialogProps} from '@/routes/settings/_components/shared'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/shadcn-components/ui/alert-dialog'
import {Badge} from '@/shadcn-components/ui/badge'
import {Dialog, DialogHeader, DialogScrollableContent, DialogTitle} from '@/shadcn-components/ui/dialog'
import {Drawer, DrawerContent, DrawerHeader, DrawerScroller, DrawerTitle} from '@/shadcn-components/ui/drawer'
import {Switch} from '@/shadcn-components/ui/switch'
import {cn} from '@/shadcn-lib/utils'
import {t} from '@/utils/i18n'
import {tw} from '@/utils/tw'

export default function ClusterSettingsDrawerOrDialog() {
	const title = t('cluster')
	const dialogProps = useSettingsDialogProps()
	const isMobile = useIsMobile()

	const cluster = useCluster()
	const joinCommand = useClusterJoinCommand()

	const [showJoinDialog, setShowJoinDialog] = React.useState(false)
	const [showRemoveDialog, setShowRemoveDialog] = React.useState<string | null>(null)
	const [clusterEnabling, setClusterEnabling] = React.useState(false)

	const handleClusterToggle = (checked: boolean) => {
		setClusterEnabling(checked)
		if (checked) {
			cluster.enable({})
		} else {
			cluster.disable()
		}
	}

	const handleShowJoinCommand = async () => {
		await joinCommand.refetch()
		setShowJoinDialog(true)
	}

	const handleRemoveNode = (nodeName: string) => {
		cluster.removeNode({name: nodeName})
		setShowRemoveDialog(null)
	}

	// Show loading cover state while enabling/disabling cluster
	if (cluster.isEnabling || cluster.isDisabling) {
		return (
			<CoverMessage>
				<Loading>{clusterEnabling ? t('cluster.enabling') : t('cluster.disabling')}</Loading>
				<CoverMessageParagraph>
					{clusterEnabling ? t('cluster.enable.description') : t('cluster.disable.description')}
				</CoverMessageParagraph>
			</CoverMessage>
		)
	}

	const content = (
		<div className='flex flex-col gap-y-3'>
			{/* Enable/Disable Cluster Toggle */}
			<div className={cn('flex flex-col gap-2', cardClass)}>
				<label className='flex w-full items-center justify-between gap-x-2'>
					<CardText
						title={t('cluster.kubernetes-mode')}
						description={cluster.isEnabled ? t('cluster.enabled-description') : t('cluster.description')}
					/>
					<Switch
						className={cn('pointer-events-auto', cluster.isLoading && 'umbrel-pulse')}
						checked={cluster.isEnabled}
						onCheckedChange={handleClusterToggle}
						disabled={cluster.isLoading}
					/>
				</label>
			</div>

			{/* Cluster Status & Nodes (only shown when enabled) */}
			{cluster.isEnabled && (
				<>
					{/* Cluster Status */}
					{cluster.status && (
						<div className={cardClass}>
							<CardText
								title={t('cluster.status')}
								description={
									<span className='flex items-center gap-2'>
										<StatusBadge status={cluster.status.connected && cluster.status.healthyNodes > 0 ? 'healthy' : 'unhealthy'} />
										<span>
											{cluster.status.totalNodes} {t('cluster.nodes')} &bull; {cluster.status.healthyNodes}{' '}
											{t('cluster.ready')}
										</span>
									</span>
								}
							/>
						</div>
					)}

					{/* Add Worker Button */}
					<div className={cn(cardClass, 'items-center')}>
						<CardText title={t('cluster.add-worker')} description={t('cluster.add-worker-description')} />
						<IconButton
							className='pointer-events-auto self-center'
							icon={TbPlus}
							onClick={handleShowJoinCommand}
							disabled={joinCommand.isLoading}
						>
							{t('cluster.add')}
						</IconButton>
					</div>

					{/* Node List */}
					<div className='mt-2'>
						<h4 className='mb-2 px-1 text-13 font-medium text-white/60'>{t('cluster.nodes')}</h4>
						<div className='flex flex-col gap-2'>
							{cluster.nodes.length === 0 ? (
								<div className={cn(cardClass, 'justify-center text-center')}>
									<span className='text-13 text-white/40'>{t('cluster.no-nodes')}</span>
								</div>
							) : (
								cluster.nodes.map((node) => (
									<NodeRow
										key={node.name}
										node={node}
										onCordon={() => cluster.cordonNode({name: node.name})}
										onUncordon={() => cluster.uncordonNode({name: node.name})}
										onRemove={() => setShowRemoveDialog(node.name)}
										isMaster={node.role === 'control-plane'}
									/>
								))
							)}
						</div>
					</div>
				</>
			)}
		</div>
	)

	// Join Command Dialog
	const joinDialog = (
		<AlertDialog open={showJoinDialog} onOpenChange={setShowJoinDialog}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t('cluster.join-command-title')}</AlertDialogTitle>
					<AlertDialogDescription>{t('cluster.join-command-description')}</AlertDialogDescription>
				</AlertDialogHeader>
				<div className='py-2'>
					{joinCommand.joinCommand ? (
						<CopyableField value={joinCommand.joinCommand} />
					) : (
						<div className='flex justify-center py-4'>
							<Loading>{t('loading')}</Loading>
						</div>
					)}
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel>{t('close')}</AlertDialogCancel>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)

	// Remove Node Confirmation Dialog
	const removeDialog = (
		<AlertDialog open={!!showRemoveDialog} onOpenChange={() => setShowRemoveDialog(null)}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t('cluster.remove-node-title')}</AlertDialogTitle>
					<AlertDialogDescription>
						{t('cluster.remove-node-description', {node: showRemoveDialog})}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
					<AlertDialogAction
						className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
						onClick={() => showRemoveDialog && handleRemoveNode(showRemoveDialog)}
					>
						{t('cluster.remove')}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)

	if (isMobile) {
		return (
			<>
				<Drawer {...dialogProps}>
					<DrawerContent fullHeight>
						<DrawerHeader>
							<DrawerTitle>{title}</DrawerTitle>
						</DrawerHeader>
						<DrawerScroller>{content}</DrawerScroller>
					</DrawerContent>
				</Drawer>
				{joinDialog}
				{removeDialog}
			</>
		)
	}

	return (
		<>
			<Dialog {...dialogProps}>
				<DialogScrollableContent>
					<div className='space-y-6 px-5 py-6'>
						<DialogHeader>
							<DialogTitle>{title}</DialogTitle>
						</DialogHeader>
						{content}
					</div>
				</DialogScrollableContent>
			</Dialog>
			{joinDialog}
			{removeDialog}
		</>
	)
}

// --- Helper Components ---

function CardText({title, description}: {title: string; description: React.ReactNode}) {
	return (
		<div className='flex-1 space-y-1'>
			<h3 className='text-14 font-medium leading-tight'>{title}</h3>
			<div className='text-13 leading-tight opacity-45'>{description}</div>
		</div>
	)
}

function StatusBadge({status}: {status: 'healthy' | 'unhealthy' | 'ready' | 'not-ready' | 'cordoned'}) {
	const variants: Record<string, {label: string; className: string}> = {
		healthy: {label: t('cluster.healthy'), className: 'bg-green-500/20 text-green-400'},
		unhealthy: {label: t('cluster.unhealthy'), className: 'bg-red-500/20 text-red-400'},
		ready: {label: t('cluster.ready'), className: 'bg-green-500/20 text-green-400'},
		'not-ready': {label: t('cluster.not-ready'), className: 'bg-yellow-500/20 text-yellow-400'},
		cordoned: {label: t('cluster.cordoned'), className: 'bg-orange-500/20 text-orange-400'},
	}

	const variant = variants[status] || variants.unhealthy

	return <Badge className={cn('text-11 font-medium', variant.className)}>{variant.label}</Badge>
}

interface ClusterNode {
	name: string
	status: 'Ready' | 'NotReady' | 'Unknown'
	role: 'control-plane' | 'worker'
	schedulable: boolean
	ip?: string
	kubeletVersion?: string
}

function NodeRow({
	node,
	onCordon,
	onUncordon,
	onRemove,
	isMaster,
}: {
	node: ClusterNode
	onCordon: () => void
	onUncordon: () => void
	onRemove: () => void
	isMaster: boolean
}) {
	const nodeStatus = !node.schedulable ? 'cordoned' : node.status === 'Ready' ? 'ready' : 'not-ready'

	return (
		<div className={cn(cardClass, 'flex-col gap-3')}>
			<div className='flex items-center justify-between'>
				<div className='flex items-center gap-2'>
					{isMaster ? (
						<RiNodeTree className='h-5 w-5 text-brand' />
					) : (
						<TbServer className='h-5 w-5 text-white/60' />
					)}
					<div>
						<div className='flex items-center gap-2'>
							<span className='text-14 font-medium'>{node.name}</span>
							{isMaster && (
								<Badge variant='outline' className='text-10'>
									{t('cluster.master')}
								</Badge>
							)}
						</div>
						{node.ip && <span className='text-12 text-white/40'>{node.ip}</span>}
					</div>
				</div>
				<StatusBadge status={nodeStatus} />
			</div>

			{/* Node Actions */}
			<div className='flex items-center justify-end gap-2'>
				{node.schedulable ? (
					<IconButton
						size='sm'
						variant='default'
						icon={TbPlayerPause}
						onClick={onCordon}
						className='pointer-events-auto'
						disabled={isMaster}
						title={isMaster ? t('cluster.cannot-cordon-master') : t('cluster.cordon')}
					>
						{t('cluster.cordon')}
					</IconButton>
				) : (
					<IconButton
						size='sm'
						variant='default'
						icon={TbPlayerPlay}
						onClick={onUncordon}
						className='pointer-events-auto'
					>
						{t('cluster.uncordon')}
					</IconButton>
				)}
				{!isMaster && (
					<IconButton
						size='sm'
						variant='destructive'
						icon={TbTrash}
						onClick={onRemove}
						className='pointer-events-auto'
					>
						{t('cluster.remove')}
					</IconButton>
				)}
			</div>
		</div>
	)
}

const cardClass = tw`flex items-start gap-x-2 rounded-12 bg-white/6 p-4 pointer-events-none`
