"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Card, CardContent, CardHeader, CardTitle } from '@open-mercato/ui/primitives/card'
import { Label } from '@open-mercato/ui/primitives/label'
import { Input } from '@open-mercato/ui/primitives/input'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'

type PipelineOption = { id: string; pipelineKey: string; name: string }

export default function CreateJobPage() {
  const router = useRouter()
  const [pipelines, setPipelines] = React.useState<PipelineOption[]>([])
  const [selectedPipelineKey, setSelectedPipelineKey] = React.useState('')
  const [name, setName] = React.useState('')
  const [itemsJson, setItemsJson] = React.useState('[\n  { "description": "Example item" }\n]')
  const [submitting, setSubmitting] = React.useState(false)
  const [jsonError, setJsonError] = React.useState<string | null>(null)

  React.useEffect(() => {
    apiCall<{ items: PipelineOption[] }>('/api/item_processing/pipelines').then((res) => {
      if (res.ok && res.result) {
        setPipelines(res.result.items ?? [])
        if (res.result.items?.length > 0) setSelectedPipelineKey(res.result.items[0].pipelineKey)
      }
    })
  }, [])

  const handleSubmit = async () => {
    let items: unknown[]
    try {
      items = JSON.parse(itemsJson)
      if (!Array.isArray(items) || items.length === 0) {
        setJsonError('Items must be a non-empty JSON array')
        return
      }
      setJsonError(null)
    } catch {
      setJsonError('Invalid JSON')
      return
    }

    setSubmitting(true)
    try {
      const res = await apiCall<{ id: string }>('/api/item_processing/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineKey: selectedPipelineKey,
          name: name || undefined,
          items,
          autoStart: true,
        }),
      })

      if (res.ok && res.result) {
        flash('Job created and started', 'success')
        router.push(`/backend/item-processing/jobs/${res.result.id}`)
      } else {
        flash('Failed to create job', 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Page>
      <PageBody>
        <h1 className="text-2xl font-semibold mb-6">Create Processing Job</h1>
        <Card>
          <CardHeader><CardTitle>Job Configuration</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="pipeline">Pipeline</Label>
              <select
                id="pipeline"
                className="w-full mt-1 border rounded-md p-2"
                value={selectedPipelineKey}
                onChange={(e) => setSelectedPipelineKey(e.target.value)}
              >
                {pipelines.map((p) => (
                  <option key={p.pipelineKey} value={p.pipelineKey}>{p.name}</option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="name">Job Name (optional)</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Invoice batch 2026-04" />
            </div>

            <div>
              <Label htmlFor="items">Items (JSON array)</Label>
              <textarea
                id="items"
                className="w-full mt-1 border rounded-md p-2 font-mono text-sm"
                rows={10}
                value={itemsJson}
                onChange={(e) => { setItemsJson(e.target.value); setJsonError(null) }}
              />
              {jsonError && <p className="text-sm text-red-500 mt-1">{jsonError}</p>}
            </div>

            <Button onClick={handleSubmit} disabled={submitting || !selectedPipelineKey}>
              {submitting ? 'Creating...' : 'Create & Start'}
            </Button>
          </CardContent>
        </Card>
      </PageBody>
    </Page>
  )
}
