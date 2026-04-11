# Customs Clearance Document Processing

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Created** | 2026-04-11 |
| **Builds on** | `packages/core/src/modules/attachments` (file upload, markitdown text extraction), `packages/core/src/modules/workflows` (step orchestration, user tasks, async activities), `packages/ai-assistant` (AI SDK, LLM provider patterns) |
| **Related** | ISZTAR4 REST API (`ext-isztar4.mf.gov.pl`), OpenRouter API |

## TLDR

**Key Points:**
- New `customs_clearance` module that automates the first step of customs clearance: parsing shipping documents (Bill of Lading, Commercial Invoice, Packing List), cross-validating their consistency, and suggesting HS tariff codes via the Polish ISZTAR4 API.
- Documents are uploaded as attachments, text-extracted via markitdown, then parsed into structured data by an LLM (via OpenRouter using `@ai-sdk/openai` with custom base URL).
- A consistency checker compares shared fields across all three documents (weights, quantities, sender/receiver, item descriptions) and flags mismatches.
- For each line item, the system queries ISZTAR4 for HS code candidates, optionally using the LLM to translate descriptions to Polish and narrow the tariff tree. The customs agent manually selects the correct code.
- The 4-step flow (Upload → Parse → Verify → Classify) is orchestrated by a seeded workflow definition with automated steps and a user task for HS code selection.

**Scope:**
- `ClearanceRequest`, `ClearanceDocument`, `ClearanceItem` entities with full extraction and consistency data
- LLM-based document parsing via OpenRouter (structured output with zod schemas)
- Cross-document consistency checker (weights, quantities, sender/receiver, item descriptions)
- ISZTAR4 API client for HS code lookup and duty rate retrieval
- Backend pages: clearance list, new clearance (upload), clearance detail (parse results, consistency report, HS classification)
- Workflow definition seeded in `setup.ts` orchestrating the 4-step pipeline
- Async worker for LLM document parsing
- i18n support (EN, PL)

**Deferred:**
- Batch processing (multiple clearance sets at once)
- Export to WinSAD or other customs declaration systems
- Historical HS code classification lookup (past decisions for similar goods)
- AI confidence scoring for HS code suggestions
- Automatic HS code selection without agent confirmation
- Customer portal access for clearance status tracking

**Concerns:**
- LLM extraction accuracy varies by document quality and language — agent must always verify parsed data
- ISZTAR4 API returns a tree structure, not a search endpoint — finding relevant codes requires navigating the hierarchy, likely with LLM assistance
- ISZTAR4 has no documented rate limits but is a government API — must handle timeouts and failures gracefully
- OpenRouter adds a dependency on a third-party LLM routing service — API key required via `OPENROUTER_API_KEY` env var

## Overview

Customs clearance begins with a repetitive, error-prone manual step: the customs agent receives three shipping documents (Bill of Lading, Commercial Invoice, Packing List), reads them, transcribes data, cross-checks consistency between documents, and looks up HS tariff codes in the customs tariff system. A single transcription error can block a container at the border.

This module automates that first step: upload the three PDFs, extract structured data via LLM, validate cross-document consistency, and present HS code suggestions from the ISZTAR4 API for the agent to confirm.

### Market Reference

**Studied:** WinSAD (Polish customs declaration software), KGH Customs (AI customs classification), Customs4Trade (HS code lookup)

**Adopted:**
- LLM-based document extraction (emerging pattern in logistics/customs tech)
- ISZTAR4 as the authoritative HS code source (official Polish/EU tariff API)
- Human-in-the-loop for final HS code selection (regulatory requirement — automated selection is not legally valid)

**Rejected:**
- OCR-only approach — structured PDFs parse better with LLM than traditional OCR pipelines
- Building a custom HS code database — ISZTAR4 is authoritative and free; maintaining a mirror adds complexity without benefit
- Fully automated classification — customs regulations require human verification of tariff codes

## Problem Statement

1. **Manual data entry**: Customs agents manually read and transcribe data from 3 documents per clearance. Each document has 10-15 fields. This takes 15-30 minutes per shipment.
2. **Cross-document errors**: Weights, quantities, and party names must match across documents. Manual comparison is tedious and errors slip through, causing border delays.
3. **HS code lookup friction**: Finding the right 10-digit HS code in a tree of ~15,000 codes requires domain expertise and time. The agent must navigate the ISZTAR4 web interface manually.
4. **No structured data**: Documents arrive as PDFs. There is no machine-readable intermediary — everything lives in the agent's head or a spreadsheet.

## Proposed Solution

### Phase 1: Module Scaffold & Data Model

Create the `customs_clearance` module with entities, validators, ACL, and basic API routes.

#### Entities

**ClearanceRequest** — one customs clearance job:

```typescript
@Entity({ tableName: 'clearance_requests' })
class ClearanceRequest {
  @PrimaryKey() id: string                          // UUID
  @Property() status: ClearanceStatus               // enum below
  @Property() title: string                         // e.g. "B/L SZSY26010596"
  @ManyToOne() organization: Organization
  @Property() tenantId: string
  @Property({ type: 'jsonb', nullable: true })
  consistencyReport: ConsistencyCheckResult[] | null
  @Property({ nullable: true }) billOfLadingAttachmentId: string
  @Property({ nullable: true }) commercialInvoiceAttachmentId: string
  @Property({ nullable: true }) packingListAttachmentId: string
  @Property() createdAt: Date
  @Property() updatedAt: Date
  @Property({ nullable: true }) completedAt: Date
  @Property({ nullable: true }) createdBy: string   // user ID
}

enum ClearanceStatus {
  DRAFT = 'draft',
  PARSING = 'parsing',
  PARSED = 'parsed',
  VERIFIED = 'verified',
  CLASSIFYING = 'classifying',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
```

**ClearanceDocument** — extracted data per document:

```typescript
@Entity({ tableName: 'clearance_documents' })
class ClearanceDocument {
  @PrimaryKey() id: string
  @ManyToOne() clearanceRequest: ClearanceRequest
  @Property() documentType: DocumentType            // bill_of_lading | commercial_invoice | packing_list
  @Property({ nullable: true }) attachmentId: string
  @Property({ type: 'text', nullable: true }) rawText: string
  @Property({ type: 'jsonb', nullable: true })
  extractedData: BillOfLadingData | CommercialInvoiceData | PackingListData
  @Property({ type: 'jsonb', nullable: true }) extractionErrors: string[]
  @Property() tenantId: string
  @Property() organizationId: string
}
```

**ClearanceItem** — per line item across documents:

```typescript
@Entity({ tableName: 'clearance_items' })
class ClearanceItem {
  @PrimaryKey() id: string
  @ManyToOne() clearanceRequest: ClearanceRequest
  @Property() description: string                   // from Commercial Invoice
  @Property({ nullable: true }) descriptionPl: string // Polish translation for ISZTAR4
  @Property({ type: 'decimal', nullable: true }) quantity: number
  @Property({ type: 'decimal', nullable: true }) unitPrice: number
  @Property({ type: 'decimal', nullable: true }) totalValue: number
  @Property({ nullable: true }) currency: string
  @Property({ type: 'decimal', nullable: true }) grossWeight: number
  @Property({ type: 'decimal', nullable: true }) netWeight: number
  @Property({ nullable: true }) containerNumber: string
  @Property({ nullable: true }) vin: string
  @Property({ nullable: true }) engineNumber: string
  @Property({ type: 'jsonb', nullable: true })
  hsCodeSuggestions: HsCodeSuggestion[]
  @Property({ nullable: true }) selectedHsCode: string
  @Property({ nullable: true }) selectedHsDescription: string
  @Property({ type: 'jsonb', nullable: true })
  selectedHsMeasures: any                           // duty rates from ISZTAR4
  @Property({ type: 'jsonb', nullable: true })
  consistencyErrors: ConsistencyError[]
  @Property() tenantId: string
  @Property() organizationId: string
}
```

#### Zod Schemas for LLM Extraction

```typescript
// Bill of Lading extraction schema
const billOfLadingSchema = z.object({
  blNumber: z.string(),
  shipper: z.object({ name: z.string(), address: z.string().optional() }),
  consignee: z.object({ name: z.string(), address: z.string().optional() }),
  notifyParty: z.string().optional(),
  vessel: z.string().optional(),
  voyage: z.string().optional(),
  portOfLoading: z.string(),
  portOfDischarge: z.string(),
  containers: z.array(z.object({
    number: z.string(),
    sealNumber: z.string().optional(),
    type: z.string().optional(),
  })),
  goodsDescription: z.string(),
  totalPackages: z.number(),
  grossWeightKg: z.number(),
  measurementCbm: z.number().optional(),
  shippedOnBoardDate: z.string().optional(),
  items: z.array(z.object({
    description: z.string(),
    vin: z.string().optional(),
    engineNumber: z.string().optional(),
    quantity: z.number().optional(),
  })).optional(),
})

// Commercial Invoice extraction schema
const commercialInvoiceSchema = z.object({
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  seller: z.object({ name: z.string(), address: z.string().optional(), country: z.string().optional() }),
  buyer: z.object({ name: z.string(), address: z.string().optional() }),
  incoterms: z.string().optional(),
  currency: z.string(),
  items: z.array(z.object({
    description: z.string(),
    containerNumber: z.string().optional(),
    vin: z.string().optional(),
    engineNumber: z.string().optional(),
    quantity: z.number(),
    unitPrice: z.number(),
    totalAmount: z.number(),
    grossWeightKg: z.number().optional(),
    netWeightKg: z.number().optional(),
    hsCode: z.string().optional(),
  })),
  totalQuantity: z.number(),
  totalAmount: z.number(),
  totalGrossWeightKg: z.number().optional(),
  totalNetWeightKg: z.number().optional(),
})

// Packing List extraction schema
const packingListSchema = z.object({
  packingListNumber: z.string().optional(),
  seller: z.object({ name: z.string(), address: z.string().optional() }),
  buyer: z.object({ name: z.string(), address: z.string().optional() }),
  items: z.array(z.object({
    description: z.string(),
    containerNumber: z.string().optional(),
    vin: z.string().optional(),
    engineNumber: z.string().optional(),
    quantity: z.number(),
    grossWeightKg: z.number(),
    netWeightKg: z.number().optional(),
    measurementCbm: z.number().optional(),
  })),
  totalQuantity: z.number(),
  totalGrossWeightKg: z.number(),
  totalNetWeightKg: z.number().optional(),
  totalMeasurementCbm: z.number().optional(),
})
```

### Phase 2: LLM Document Parsing via OpenRouter

#### OpenRouter Provider Setup

```typescript
// lib/openrouter.ts
import { createOpenAI } from '@ai-sdk/openai'

export function createOpenRouterProvider() {
  return createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  })
}

export function getParsingModel() {
  const provider = createOpenRouterProvider()
  // Gemini 2.5 Flash: fast, cheap, good at structured extraction
  return provider(process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash')
}
```

#### Document Parser

```typescript
// lib/document-parser.ts
import { generateObject } from 'ai'

export async function parseDocument(
  rawText: string,
  documentType: DocumentType,
  schema: ZodSchema,
): Promise<{ data: any; errors: string[] }> {
  const systemPrompt = `You are a customs document parser. Extract structured data from the provided shipping document text. Be precise with numbers, dates, and identifiers. If a field is not present in the document, omit it.`

  const result = await generateObject({
    model: getParsingModel(),
    schema,
    system: systemPrompt,
    prompt: `Extract all fields from this ${documentType} document:\n\n${rawText}`,
  })

  return { data: result.object, errors: [] }
}
```

#### Async Worker

The parsing worker processes all 3 documents for a clearance request:

1. Load the 3 attachments and their `content` field (text extracted by markitdown)
2. Call `parseDocument()` for each with the appropriate zod schema
3. Save `ClearanceDocument` records with extracted data
4. Create `ClearanceItem` records from the invoice line items
5. Update `ClearanceRequest.status` to `parsed`

### Phase 3: Consistency Checker

Pure logic — no LLM needed. Compares fields that appear in multiple documents.

```typescript
// lib/consistency-checker.ts

interface ConsistencyCheckResult {
  field: string
  source1: string        // e.g. "Bill of Lading"
  source2: string        // e.g. "Packing List"
  value1: string | number
  value2: string | number
  status: 'match' | 'mismatch' | 'warning'
  tolerance?: string     // e.g. "0 kg" or "name similarity"
  message?: string
}

export function checkConsistency(
  billOfLading: BillOfLadingData,
  commercialInvoice: CommercialInvoiceData,
  packingList: PackingListData,
): ConsistencyCheckResult[] {
  const results: ConsistencyCheckResult[] = []

  // 1. Gross weight: B/L vs Packing List (must match exactly)
  results.push(compareNumeric(
    'Total Gross Weight (kg)',
    'Bill of Lading', billOfLading.grossWeightKg,
    'Packing List', packingList.totalGrossWeightKg,
    0,
  ))

  // 2. Gross weight: B/L vs Commercial Invoice (small tolerance if invoice has net only)
  if (commercialInvoice.totalGrossWeightKg) {
    results.push(compareNumeric(
      'Total Gross Weight (kg)',
      'Bill of Lading', billOfLading.grossWeightKg,
      'Commercial Invoice', commercialInvoice.totalGrossWeightKg,
      0,
    ))
  }

  // 3. Net weight: Packing List vs Commercial Invoice (must match)
  if (packingList.totalNetWeightKg && commercialInvoice.totalNetWeightKg) {
    results.push(compareNumeric(
      'Total Net Weight (kg)',
      'Packing List', packingList.totalNetWeightKg,
      'Commercial Invoice', commercialInvoice.totalNetWeightKg,
      0,
    ))
  }

  // 4. Total packages: B/L vs Packing List (must match)
  results.push(compareNumeric(
    'Total Packages',
    'Bill of Lading', billOfLading.totalPackages,
    'Packing List', packingList.totalQuantity,
    0,
  ))

  // 5. Sender/Shipper name: B/L vs Commercial Invoice (fuzzy match)
  results.push(compareStringSimilarity(
    'Sender / Shipper',
    'Bill of Lading', billOfLading.shipper.name,
    'Commercial Invoice', commercialInvoice.seller.name,
  ))

  // 6. Receiver/Consignee name: B/L vs Commercial Invoice (fuzzy match)
  results.push(compareStringSimilarity(
    'Receiver / Consignee',
    'Bill of Lading', billOfLading.consignee.name,
    'Commercial Invoice', commercialInvoice.buyer.name,
  ))

  // 7. Per-item comparison: Invoice items vs Packing List items
  // Match by container number + VIN or by position, compare descriptions and weights
  results.push(...compareLineItems(commercialInvoice.items, packingList.items))

  return results
}
```

### Phase 4: ISZTAR4 Integration & HS Code Classification

#### ISZTAR4 Client

```typescript
// lib/isztar-client.ts

const BASE_URL = 'https://ext-isztar4.mf.gov.pl/tariff/rest'

export async function getGoodsNomenclatureCodes(
  page: number,
  language: 'EN' | 'PL' = 'PL',
  date?: string,
): Promise<NomenclatureTree> {
  const params = new URLSearchParams({ page: String(page), language })
  if (date) params.set('date', date)
  const response = await fetch(`${BASE_URL}/goods-nomenclature/codes?${params}`)
  return response.json()
}

export async function getMeasures(
  nomenclatureCode: string,
  language: 'EN' | 'PL' = 'PL',
  date?: string,
): Promise<MeasuresResponse> {
  const code = nomenclatureCode.padEnd(10, '0')
  const params = new URLSearchParams({ nomenclatureCode: code, language })
  if (date) params.set('date', date)
  const response = await fetch(`${BASE_URL}/goods-nomenclature/measures?${params}`)
  return response.json()
}
```

#### HS Code Search Strategy

ISZTAR4 does not have a text search endpoint. The `/goods-nomenclature/codes` endpoint returns paginated sections of the tariff tree. Strategy:

1. **LLM-assisted chapter identification**: Send the product description to the LLM and ask it to identify the likely 2-digit HS chapter (e.g., "87" for vehicles) and 4-digit heading.
2. **Fetch the chapter tree**: Use the ISZTAR4 codes endpoint with the right page number (sections map to pages).
3. **LLM-assisted filtering**: From the subtree, ask the LLM to rank the 5 most likely 10-digit codes for the product.
4. **Fetch measures**: For each candidate code, call the measures endpoint to get duty rates.
5. **Present to agent**: Show candidates with descriptions and duty rates. Agent selects one.

```typescript
// lib/hs-code-search.ts

export async function suggestHsCodes(
  itemDescription: string,
  itemDescriptionPl: string,
): Promise<HsCodeSuggestion[]> {
  // Step 1: Ask LLM for likely HS chapter and heading
  const { object: classification } = await generateObject({
    model: getParsingModel(),
    schema: z.object({
      chapterCode: z.string().describe('2-digit HS chapter code'),
      headingCode: z.string().describe('4-digit HS heading code'),
      reasoning: z.string(),
      alternativeHeadings: z.array(z.string()).optional(),
    }),
    system: 'You are an EU customs tariff expert. Given a product description, identify the most likely HS chapter (2-digit) and heading (4-digit) from the Combined Nomenclature.',
    prompt: `Product: ${itemDescription}\nPolish: ${itemDescriptionPl}`,
  })

  // Step 2: Fetch the relevant section from ISZTAR4
  const sectionPage = chapterToPage(classification.chapterCode)
  const tree = await getGoodsNomenclatureCodes(sectionPage, 'EN')

  // Step 3: Extract candidate 10-digit codes from the subtree
  const candidates = flattenTree(tree, classification.headingCode)

  // Step 4: Ask LLM to rank candidates
  const { object: ranked } = await generateObject({
    model: getParsingModel(),
    schema: z.object({
      rankedCodes: z.array(z.object({
        code: z.string(),
        description: z.string(),
        confidence: z.enum(['high', 'medium', 'low']),
        reasoning: z.string(),
      })).max(10),
    }),
    prompt: `Product: ${itemDescription}\n\nCandidate HS codes:\n${candidates.map(c => `${c.code} - ${c.description}`).join('\n')}\n\nRank the top codes by relevance.`,
  })

  // Step 5: Fetch measures for top candidates
  const suggestions: HsCodeSuggestion[] = []
  for (const code of ranked.rankedCodes.slice(0, 5)) {
    const measures = await getMeasures(code.code)
    suggestions.push({
      code: code.code,
      description: code.description,
      confidence: code.confidence,
      reasoning: code.reasoning,
      dutyRate: measures.tariffMeasures?.[0]?.dutyAmount,
      measures: measures.tariffMeasures,
    })
  }

  return suggestions
}
```

### Phase 5: Backend UI Pages

#### Clearance List Page (`backend/page.tsx`)

DataTable listing all clearance requests with columns:
- Title (B/L number), Status (badge), Created, Items count, Total value

#### New Clearance Page (`backend/clearances/new.tsx`)

Three file upload zones labeled "Bill of Lading", "Commercial Invoice", "Packing List". Upload button creates the `ClearanceRequest` and triggers the parsing workflow.

#### Clearance Detail Page (`backend/clearances/[id].tsx`)

Tabbed or stepped view showing all 4 phases:

**Tab 1 — Documents**: The 3 uploaded PDFs with extracted raw text preview.

**Tab 2 — Parsed Data**: Structured data extracted from each document in a clean table format. Agent can review and correct values.

**Tab 3 — Consistency Report**: Table showing each cross-document comparison with:
- Field name, Source 1 value, Source 2 value, Status (green check / red X / yellow warning)
- Expandable details for each mismatch

**Tab 4 — HS Classification**: For each line item:
- Product description (original + Polish translation)
- "Search ISZTAR4" button → shows suggested codes with descriptions and duty rates
- Agent clicks to select a code → saved to `ClearanceItem.selectedHsCode`
- Summary table of all items with selected codes

### Phase 6: Workflow Definition

Seeded via `setup.ts`:

```json
{
  "workflowId": "customs_clearance_processing",
  "workflowName": "Customs Clearance Document Processing",
  "version": 1,
  "definition": {
    "steps": [
      { "stepId": "start", "stepName": "Start", "stepType": "START" },
      { "stepId": "parse_documents", "stepName": "Parse Documents", "stepType": "AUTOMATED" },
      { "stepId": "verify_consistency", "stepName": "Verify Consistency", "stepType": "AUTOMATED" },
      { "stepId": "classify_hs", "stepName": "Classify HS Codes", "stepType": "USER_TASK",
        "userTaskConfig": {
          "taskName": "Review and Select HS Codes",
          "description": "Review extracted data, consistency report, and select HS codes for each item",
          "formSchema": {
            "type": "object",
            "properties": {
              "confirmed": { "type": "boolean", "description": "All HS codes selected and verified" }
            },
            "required": ["confirmed"]
          }
        }
      },
      { "stepId": "end", "stepName": "Completed", "stepType": "END" }
    ],
    "transitions": [
      { "transitionId": "start_to_parse", "fromStepId": "start", "toStepId": "parse_documents", "trigger": "auto", "priority": 100 },
      { "transitionId": "parse_to_verify", "fromStepId": "parse_documents", "toStepId": "verify_consistency", "trigger": "auto", "priority": 100,
        "activities": [{
          "activityId": "parse_docs",
          "activityType": "EXECUTE_FUNCTION",
          "async": true,
          "config": { "functionName": "customsClearance.parseDocuments", "args": { "clearanceRequestId": "{{context.clearanceRequestId}}" } }
        }]
      },
      { "transitionId": "verify_to_classify", "fromStepId": "verify_consistency", "toStepId": "classify_hs", "trigger": "auto", "priority": 100,
        "activities": [{
          "activityId": "run_consistency_check",
          "activityType": "EXECUTE_FUNCTION",
          "config": { "functionName": "customsClearance.checkConsistency", "args": { "clearanceRequestId": "{{context.clearanceRequestId}}" } }
        }]
      },
      { "transitionId": "classify_to_end", "fromStepId": "classify_hs", "toStepId": "end", "trigger": "manual", "priority": 100 }
    ]
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Backend UI Pages                      │
│  List → New (Upload) → Detail (Parse/Verify/Classify)   │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                  API Routes (/api/)                       │
│  POST clearances, GET clearances/:id, POST parse,        │
│  GET isztar/:code, POST items/:id/hs-code                │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│               Workflow Engine                            │
│  START → PARSE (async) → VERIFY → CLASSIFY (user task)   │
└────┬─────────────┬───────────────┬──────────────────────┘
     │             │               │
┌────▼────┐  ┌─────▼─────┐  ┌─────▼──────┐
│Attachments│ │ OpenRouter │  │  ISZTAR4   │
│(upload +  │ │  (LLM via  │  │  (tariff   │
│markitdown)│ │  ai-sdk)   │  │   API)     │
└───────────┘ └───────────┘  └────────────┘
```

## API Contracts

### POST /api/customs-clearance/clearances
Create a new clearance request with 3 attachment IDs.

**Request:**
```json
{
  "billOfLadingAttachmentId": "uuid",
  "commercialInvoiceAttachmentId": "uuid",
  "packingListAttachmentId": "uuid",
  "title": "B/L SZSY26010596"
}
```

**Response:** `201` with `ClearanceRequest` object.

### GET /api/customs-clearance/clearances/:id
Returns the full clearance request with documents, items, and consistency report.

### POST /api/customs-clearance/clearances/:id/parse
Triggers async document parsing. Returns `202 Accepted`.

### GET /api/customs-clearance/clearances/:id/isztar/:itemId
Queries ISZTAR4 for HS code suggestions for a specific item. Returns array of `HsCodeSuggestion`.

### POST /api/customs-clearance/clearances/:id/items/:itemId/hs-code
Save the agent's HS code selection.

**Request:**
```json
{
  "hsCode": "8704230000",
  "hsDescription": "Motor vehicles for transport of goods - GVW > 20 tonnes"
}
```

## Risks & Impact Review

| Risk | Severity | Affected Area | Mitigation | Residual Risk |
|------|----------|---------------|------------|---------------|
| LLM extraction inaccuracy | Medium | Data quality | Agent always reviews parsed data; editable fields | Agent may miss subtle errors |
| ISZTAR4 API downtime | Low | HS classification | Timeout handling, retry, fallback to manual lookup | Agent falls back to web browser |
| OpenRouter API cost | Low | Operations | Use cheap model (Gemini Flash); cache repeated queries | Unexpected cost spike on high volume |
| Document format variation | Medium | Parsing | Flexible zod schemas with optional fields; LLM handles format diversity | Unusual document layouts may parse poorly |
| Rate limiting by ISZTAR4 | Low | HS classification | Sequential requests with small delays; cache responses | Could be throttled under heavy use |

## Final Compliance Report

- [ ] No direct ORM relationships between modules (uses attachment IDs, not relations)
- [ ] All entities tenant-scoped (`organizationId`, `tenantId`)
- [ ] Inputs validated with zod (`data/validators.ts`)
- [ ] API routes export `openApi` specs
- [ ] ACL features declared in `acl.ts` with defaults in `setup.ts`
- [ ] Events declared in `events.ts` with `as const`
- [ ] i18n: no hardcoded strings, locale files for EN/PL
- [ ] Worker uses queue contract (`workers/parse-documents.ts`)
- [ ] Workflow definition seeded in `setup.ts`
- [ ] No `any` types — zod schemas with `z.infer`

## Team Split

Three parallel workstreams. Jacek delivers the module scaffold + entities + zod schemas first (~1h) to unblock the other two.

### Jacek: Workflow + Parsing + API

Module foundation and the core document processing pipeline.

| File | Purpose |
|------|---------|
| `index.ts` | Module metadata |
| `acl.ts` | `customs_clearance.view`, `.create`, `.manage` |
| `setup.ts` | Seed workflow definition, default role features |
| `events.ts` | `customs_clearance.clearance.created`, `.parsed`, `.completed` |
| `ce.ts` | Custom entity declarations |
| `data/entities.ts` | ClearanceRequest, ClearanceDocument, ClearanceItem |
| `data/validators.ts` | Zod schemas for all entities and LLM extraction |
| `lib/openrouter.ts` | OpenRouter provider via `@ai-sdk/openai` |
| `lib/document-parser.ts` | LLM-based structured extraction (B/L, Invoice, Packing List) |
| `lib/consistency-checker.ts` | Cross-document validation (weights, quantities, names) |
| `workers/parse-documents.ts` | Async worker: extract text → LLM parse → consistency check |
| `api/post/clearances.ts` | Create clearance request |
| `api/get/clearances.ts` | List clearance requests |
| `api/get/clearances/[id].ts` | Get single clearance with documents, items, report |
| `api/post/clearances/[id]/parse.ts` | Trigger async document parsing |
| Workflow definition JSON | START → PARSE → VERIFY → CLASSIFY (user task) → END |

**Delivers first**: entities + zod schemas + API stubs so Konrad and Piotr can start.

### Konrad: ISZTAR4 & HS Classification

ISZTAR4 API integration and the HS code selection flow.

| File | Purpose |
|------|---------|
| `lib/isztar-client.ts` | ISZTAR4 REST API client (codes, measures, quotas) |
| `lib/hs-code-search.ts` | LLM-assisted chapter identification + candidate ranking |
| `api/get/clearances/[id]/isztar/[itemId].ts` | Query ISZTAR4 suggestions for a specific item |
| `api/post/clearances/[id]/items/[itemId]/hs-code.ts` | Save agent's HS code selection |

**Depends on**: `ClearanceItem` entity shape and extraction zod schemas from Jacek.

**Key decisions**:
- Uses OpenRouter (same provider as parsing) for description translation and chapter identification
- ISZTAR4 has no search endpoint — LLM narrows the tariff tree first, then candidates are fetched and ranked
- Agent always makes the final selection (regulatory requirement)

### Piotr: Frontend / UI

All backend pages and user-facing components.

| File | Purpose |
|------|---------|
| `backend/page.tsx` | Clearance list (DataTable with status, title, items, value) |
| `backend/clearances/new.tsx` | Upload page with 3 file zones (B/L, Invoice, Packing List) |
| `backend/clearances/[id].tsx` | Detail page with 4 tabs (see below) |
| `i18n/en.json` | English translations |
| `i18n/pl.json` | Polish translations |

**Detail page tabs**:
1. **Documents** — uploaded PDFs with raw text preview
2. **Parsed Data** — structured extraction results in table form, editable
3. **Consistency Report** — comparison table with match/mismatch/warning badges
4. **HS Classification** — item list with "Search ISZTAR4" button, code picker, duty rates

**Depends on**: API route contracts from Jacek (can mock data until routes are live). HS classification tab wires to Konrad's ISZTAR4 routes.

### Coordination Points

1. **Hour 0**: Jacek shares entity shapes + zod schemas + API contracts (request/response types)
2. **Hour 0-1**: Konrad starts `isztar-client.ts` (no dependencies); Piotr starts page layouts with mock data
3. **Hour 1-3**: All three work in parallel on their workstreams
4. **Hour 3-4**: Integration — wire Konrad's libs into API routes, Piotr's pages hit real APIs, end-to-end test with sample PDFs

## Module File Checklist

| File | Owner | Status | Purpose |
|------|-------|--------|---------|
| `index.ts` | Jacek | Planned | Module metadata |
| `acl.ts` | Jacek | Planned | Feature-based permissions |
| `setup.ts` | Jacek | Planned | Seed workflow definition |
| `events.ts` | Jacek | Planned | Typed event declarations |
| `ce.ts` | Jacek | Planned | Custom entity declarations |
| `data/entities.ts` | Jacek | Planned | ClearanceRequest, ClearanceDocument, ClearanceItem |
| `data/validators.ts` | Jacek | Planned | Zod schemas for all entities and LLM extraction |
| `lib/openrouter.ts` | Jacek | Planned | OpenRouter provider via `@ai-sdk/openai` |
| `lib/document-parser.ts` | Jacek | Planned | LLM-based structured extraction |
| `lib/consistency-checker.ts` | Jacek | Planned | Cross-document validation |
| `lib/isztar-client.ts` | Konrad | Planned | ISZTAR4 REST API client |
| `lib/hs-code-search.ts` | Konrad | Planned | LLM-assisted HS code lookup |
| `api/` (CRUD + parse) | Jacek | Planned | Create, list, get, parse clearances |
| `api/` (ISZTAR4 + HS) | Konrad | Planned | HS code search and selection |
| `backend/` | Piotr | Planned | List, new, detail pages |
| `workers/parse-documents.ts` | Jacek | Planned | Async LLM parsing worker |
| `i18n/en.json`, `i18n/pl.json` | Piotr | Planned | Translations |

## Changelog

| Date | Change |
|------|--------|
| 2026-04-11 | Initial draft |
| 2026-04-11 | Added team split: Jacek (workflow/parsing/API), Konrad (ISZTAR4/HS), Piotr (UI) |
