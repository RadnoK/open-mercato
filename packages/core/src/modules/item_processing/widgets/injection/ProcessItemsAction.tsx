export const metadata = {
  id: 'item_processing.bulk.process_items',
}

export const menuItems = [
  {
    id: 'item-processing-bulk-process',
    labelKey: 'item_processing.actions.process_items',
    icon: 'lucide:play',
    action: 'navigate' as const,
    href: '/backend/item-processing/jobs/create',
  },
]
