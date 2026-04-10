"use client"
import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { ColumnDef } from '@tanstack/react-table'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { Card, CardContent, CardHeader, CardTitle } from '@open-mercato/ui/primitives/card'
import { Label } from '@open-mercato/ui/primitives/label'
import { Input } from '@open-mercato/ui/primitives/input'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Plus } from 'lucide-react'

type PipelineRow = {
  id: string
  pipelineKey: string
  name: string
  description: string | null
  steps: any[]
  isActive: boolean
}

export default function PipelinesPage() {
  const [pipelines, setPipelines] = React.useState<PipelineRow[]>([])
  const [showCreate, setShowCreate] = React.useState(false)
  const [newKey, setNewKey] = React.useState('')
  const [newName, setNewName] = React.useState('')
  const [newStepsJson, setNewStepsJson] = React.useState('[]')
  const [creating, setCreating] = React.useState(false)

  const fetchPipelines = React.useCallback(async () => {
    const res = await apiCall<{ items: PipelineRow[] }>('/api/item_processing/pipelines')
    if (res.ok && res.result) {
      setPipelines(res.result.items ?? [])
    }
  }, [])

  React.useEffect(() => { fetchPipelines() }, [fetchPipelines])

  const handleCreate = async () => {
    let steps: unknown[]
    try {
      steps = JSON.parse(newStepsJson)
    } catch {
      flash('Invalid JSON for steps', 'error')
      return
    }

    setCreating(true)
    try {
      const res = await apiCall('/api/item_processing/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineKey: newKey, name: newName, steps }),
      })
      if (res.ok) {
        flash('Pipeline created', 'success')
        setShowCreate(false)
        setNewKey('')
        setNewName('')
        setNewStepsJson('[]')
        fetchPipelines()
      } else {
        flash('Failed to create pipeline', 'error')
      }
    } finally {
      setCreating(false)
    }
  }

  const columns: ColumnDef<PipelineRow>[] = React.useMemo(() => [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'pipelineKey', header: 'Key', cell: ({ row }) => <code className="text-sm">{row.original.pipelineKey}</code> },
    { id: 'steps', header: 'Steps', cell: ({ row }) => row.original.steps?.length ?? 0 },
    {
      accessorKey: 'isActive',
      header: 'Active',
      cell: ({ row }) => <Badge variant={row.original.isActive ? 'default' : 'secondary'}>{row.original.isActive ? 'Active' : 'Inactive'}</Badge>,
    },
  ], [])

  return (
    <Page>
      <PageBody>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-semibold">Pipelines</h1>
          <Button onClick={() => setShowCreate(!showCreate)}>
            <Plus className="w-4 h-4 mr-2" /> New Pipeline
          </Button>
        </div>

        {showCreate && (
          <Card className="mb-6">
            <CardHeader><CardTitle>Create Pipeline</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label htmlFor="key">Pipeline Key</Label>
                <Input id="key" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="e.g. my_pipeline" />
              </div>
              <div>
                <Label htmlFor="pname">Name</Label>
                <Input id="pname" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Pipeline" />
              </div>
              <div>
                <Label htmlFor="steps">Steps (JSON)</Label>
                <textarea id="steps" className="w-full border rounded-md p-2 font-mono text-sm" rows={8} value={newStepsJson} onChange={(e) => setNewStepsJson(e.target.value)} />
              </div>
              <Button onClick={handleCreate} disabled={creating || !newKey || !newName}>
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </CardContent>
          </Card>
        )}

        <DataTable columns={columns} data={pipelines} />
      </PageBody>
    </Page>
  )
}
