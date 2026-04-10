"use client"
import * as React from 'react'
import { useParams } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { ColumnDef } from '@tanstack/react-table'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { Card, CardContent, CardHeader, CardTitle } from '@open-mercato/ui/primitives/card'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'

type JobDetail = {
  id: string
  name: string | null
  status: string
  currentStep: string | null
  totalItems: number
  processedItems: number
  failedItems: number
  skippedItems: number
  config: any[]
  resultSummary: any
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

type ItemRow = {
  id: string
  itemIndex: number
  status: string
  currentStep: string | null
  inputData: Record<string, unknown>
  outputData: Record<string, unknown> | null
  stepResults: Record<string, any> | null
  selectedValues: Record<string, unknown> | null
  errorMessage: string | null
}

const ITEM_STATUS_COLORS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  processing: 'default',
  awaiting_review: 'outline',
  completed: 'default',
  failed: 'destructive',
  skipped: 'secondary',
}

export default function JobDetailPage() {
  const params = useParams()
  const jobId = params.id as string

  const [job, setJob] = React.useState<JobDetail | null>(null)
  const [items, setItems] = React.useState<ItemRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selections, setSelections] = React.useState<Record<string, Record<string, unknown>>>({})
  const [submitting, setSubmitting] = React.useState(false)

  const fetchData = React.useCallback(async () => {
    const [jobRes, itemsRes] = await Promise.all([
      apiCall<JobDetail>(`/api/item_processing/jobs/${jobId}`),
      apiCall<{ items: ItemRow[]; total: number }>(`/api/item_processing/jobs/${jobId}/items?pageSize=100`),
    ])
    if (jobRes.ok && jobRes.result) setJob(jobRes.result)
    if (itemsRes.ok && itemsRes.result) {
      setItems(itemsRes.result.items ?? [])
    }
    setLoading(false)
  }, [jobId])

  React.useEffect(() => { fetchData() }, [fetchData])

  useAppEvent('item_processing.job.step_completed', fetchData)
  useAppEvent('item_processing.job.completed', fetchData)
  useAppEvent('item_processing.job.failed', fetchData)
  useAppEvent('item_processing.job.paused_for_review', fetchData)

  const awaitingItems = items.filter((i) => i.status === 'awaiting_review')
  const isPaused = job?.status === 'paused'

  const handleSelectSuggestion = (itemId: string, value: Record<string, unknown>) => {
    setSelections((prev) => ({ ...prev, [itemId]: value }))
  }

  const handleSubmitReviews = async () => {
    const selectionList = Object.entries(selections).map(([itemId, selectedValue]) => ({
      itemId,
      selectedValue,
    }))

    if (selectionList.length === 0) {
      flash('Select at least one item to review', 'error')
      return
    }

    setSubmitting(true)
    try {
      const res = await apiCall(`/api/item_processing/jobs/${jobId}/review/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections: selectionList, resume: true }),
      })
      if (res.ok) {
        flash('Reviews submitted, job resuming', 'success')
        setSelections({})
        fetchData()
      } else {
        flash('Failed to submit reviews', 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const columns: ColumnDef<ItemRow>[] = React.useMemo(() => [
    { accessorKey: 'itemIndex', header: '#', size: 50 },
    {
      id: 'description',
      header: 'Description',
      cell: ({ row }) => {
        const desc = row.original.inputData?.description ?? row.original.inputData?.name ?? JSON.stringify(row.original.inputData).slice(0, 80)
        return <span className="text-sm">{String(desc).slice(0, 100)}</span>
      },
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const agentResult = getAgentResult(row.original)
        return (
          <div className="flex gap-1">
            <Badge variant={ITEM_STATUS_COLORS[row.original.status] ?? 'secondary'}>
              {row.original.status}
            </Badge>
            {agentResult?.finalDecision === 'auto_approved' && (
              <Badge variant="default" className="text-xs">AI approved</Badge>
            )}
            {agentResult?.finalDecision === 'escalated' && (
              <Badge variant="outline" className="text-xs">AI escalated</Badge>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: 'currentStep',
      header: 'Step',
      cell: ({ row }) => row.original.currentStep ?? '—',
    },
    {
      id: 'result',
      header: 'Result',
      cell: ({ row }) => {
        if (row.original.selectedValues) {
          const vals = Object.values(row.original.selectedValues)
          if (vals.length > 0) {
            const last = vals[vals.length - 1] as Record<string, unknown>
            return <span className="text-sm font-mono">{String(last?.hsCode ?? last?.label ?? JSON.stringify(last).slice(0, 50))}</span>
          }
        }
        if (row.original.errorMessage) {
          return <span className="text-sm text-red-500">{row.original.errorMessage.slice(0, 60)}</span>
        }
        return '—'
      },
    },
  ], [])

  if (loading) return <Page><PageBody><p>Loading...</p></PageBody></Page>
  if (!job) return <Page><PageBody><p>Job not found</p></PageBody></Page>

  const progressPct = job.totalItems > 0 ? Math.round((job.processedItems / job.totalItems) * 100) : 0

  return (
    <Page>
      <PageBody>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">{job.name ?? `Job ${job.id.slice(0, 8)}`}</h1>
            <div className="flex gap-2 mt-2">
              <Badge variant={ITEM_STATUS_COLORS[job.status] as any ?? 'secondary'}>{job.status}</Badge>
              {job.currentStep && <Badge variant="outline">Step: {job.currentStep}</Badge>}
            </div>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>Created: {new Date(job.createdAt).toLocaleString()}</div>
            {job.startedAt && <div>Started: {new Date(job.startedAt).toLocaleString()}</div>}
            {job.completedAt && <div>Completed: {new Date(job.completedAt).toLocaleString()}</div>}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-6">
          <div className="flex justify-between text-sm mb-1">
            <span>Progress: {job.processedItems}/{job.totalItems} items</span>
            <span>{progressPct}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
          </div>
          {job.failedItems > 0 && (
            <p className="text-sm text-red-500 mt-1">{job.failedItems} failed items</p>
          )}
        </div>

        {/* Review panel */}
        {isPaused && awaitingItems.length > 0 && (
          <Card className="mb-6 border-orange-200 bg-orange-50">
            <CardHeader>
              <CardTitle>{awaitingItems.length} items need your review</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {awaitingItems.map((item) => {
                const suggestions = getSuggestions(item)
                const agentResult = getAgentResult(item)

                return (
                  <div key={item.id} className="border rounded-lg p-4 bg-white">
                    <div className="flex justify-between mb-2">
                      <span className="font-medium">#{item.itemIndex}: {String(item.inputData?.description ?? '').slice(0, 80)}</span>
                      {agentResult && (
                        <Badge variant="outline" className="text-xs">
                          AI recommends ({agentResult.agentConfidence}%): {agentResult.agentReasoning?.slice(0, 60)}
                        </Badge>
                      )}
                    </div>

                    {suggestions.length > 0 ? (
                      <div className="space-y-1">
                        {suggestions.map((s: any) => (
                          <label key={s.id} className="flex items-center gap-2 p-2 rounded hover:bg-gray-50 cursor-pointer">
                            <input
                              type="radio"
                              name={`review-${item.id}`}
                              checked={selections[item.id]?.id === s.id}
                              onChange={() => handleSelectSuggestion(item.id, s.value)}
                            />
                            <span className="text-sm">
                              <strong>{s.label}</strong>
                              {s.confidence != null && <span className="text-muted-foreground ml-2">({s.confidence}%)</span>}
                            </span>
                            {agentResult?.agentSelectedSuggestionId === s.id && (
                              <Badge variant="outline" className="text-xs ml-auto">AI pick</Badge>
                            )}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No suggestions available — manual input needed</p>
                    )}
                  </div>
                )
              })}

              <Button onClick={handleSubmitReviews} disabled={submitting || Object.keys(selections).length === 0}>
                {submitting ? 'Submitting...' : `Submit ${Object.keys(selections).length} Reviews & Continue`}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Items table */}
        <Card>
          <CardHeader><CardTitle>Items ({items.length})</CardTitle></CardHeader>
          <CardContent>
            <DataTable columns={columns} data={items} />
          </CardContent>
        </Card>

        {/* Result summary */}
        {job.resultSummary && (
          <Card className="mt-4">
            <CardHeader><CardTitle>Result Summary</CardTitle></CardHeader>
            <CardContent>
              <pre className="text-sm font-mono bg-gray-50 p-4 rounded overflow-auto">
                {JSON.stringify(job.resultSummary, null, 2)}
              </pre>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </Page>
  )
}

function getSuggestions(item: ItemRow): any[] {
  if (!item.stepResults) return []
  for (const result of Object.values(item.stepResults)) {
    if (result?.suggestions && Array.isArray(result.suggestions) && result.suggestions.length > 0) {
      return result.suggestions
    }
  }
  return []
}

function getAgentResult(item: ItemRow): any | null {
  if (!item.stepResults) return null
  for (const result of Object.values(item.stepResults)) {
    if (result?.decidedBy && result?.agentConfidence != null) {
      return result
    }
  }
  return null
}
