"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { ColumnDef } from '@tanstack/react-table'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { Plus } from 'lucide-react'

type JobRow = {
  id: string
  name: string | null
  pipelineId: string
  status: string
  currentStep: string | null
  totalItems: number
  processedItems: number
  failedItems: number
  createdAt: string
}

const STATUS_COLORS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  running: 'default',
  paused: 'outline',
  completed: 'default',
  failed: 'destructive',
  cancelled: 'secondary',
}

export default function ItemProcessingPage() {
  const router = useRouter()
  const [rows, setRows] = React.useState<JobRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)

  const fetchJobs = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiCall<{ items: JobRow[]; total: number }>('/api/item_processing/jobs?pageSize=50')
      if (res.ok && res.result) {
        setRows(res.result.items ?? [])
        setTotal(res.result.total ?? 0)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { fetchJobs() }, [fetchJobs])

  useAppEvent('item_processing.job.step_completed', fetchJobs)
  useAppEvent('item_processing.job.completed', fetchJobs)
  useAppEvent('item_processing.job.failed', fetchJobs)
  useAppEvent('item_processing.job.paused_for_review', fetchJobs)

  const columns: ColumnDef<JobRow>[] = React.useMemo(() => [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => row.original.name ?? `Job ${row.original.id.slice(0, 8)}`,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={STATUS_COLORS[row.original.status] ?? 'secondary'}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: 'progress',
      header: 'Progress',
      cell: ({ row }) => `${row.original.processedItems}/${row.original.totalItems}`,
    },
    {
      accessorKey: 'currentStep',
      header: 'Current Step',
      cell: ({ row }) => row.original.currentStep ?? '—',
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <RowActions
          items={[
            { id: 'view', label: 'View', href: `/backend/item-processing/jobs/${row.original.id}` },
            ...(['running', 'paused'].includes(row.original.status) ? [{
              id: 'cancel', label: 'Cancel', onSelect: async () => {
                await apiCall(`/api/item_processing/jobs/${row.original.id}/cancel`, { method: 'POST' })
                flash('Job cancelled', 'success')
                fetchJobs()
              },
            }] : []),
            ...(row.original.failedItems > 0 ? [{
              id: 'retry', label: 'Retry Failed', onSelect: async () => {
                await apiCall(`/api/item_processing/jobs/${row.original.id}/retry`, { method: 'POST' })
                flash('Retrying failed items', 'success')
                fetchJobs()
              },
            }] : []),
          ]}
        />
      ),
    },
  ], [router, fetchJobs])

  return (
    <Page>
      <PageBody>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-semibold">Processing Jobs</h1>
          <Button onClick={() => router.push('/backend/item-processing/jobs/create')}>
            <Plus className="w-4 h-4 mr-2" /> New Job
          </Button>
        </div>
        <DataTable columns={columns} data={rows} />
      </PageBody>
    </Page>
  )
}
