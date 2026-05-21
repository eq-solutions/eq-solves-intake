/**
 * POST /api/parse-maximo-pdf
 *
 * Accepts up to 4 Maximo WO PDFs as multipart/form-data, runs the
 * `maximo-pdf-wo` skill from @eq/intake against them, and returns the
 * canonical bundles + warnings + per-file source metadata.
 *
 * Auth: writer-or-above only (same gate as the xlsx import flow).
 *
 * Why nodejs + maxDuration 300:
 *   The skill routes scanned PDFs through Claude vision via @eq/ai. Vision
 *   calls take 20-80s per PDF. The Edge runtime can't run the Anthropic
 *   provider (it uses Node fetch features). 300s is the Netlify Pro
 *   background-function ceiling; if 4 PDFs at the slow end of the range
 *   pile up close to that we'll move this to a background pattern.
 */
import { NextRequest, NextResponse } from 'next/server'
import { AnthropicProvider } from '@eq/ai'
import { parseMaximoPdfWo, type MaximoPdfWoResult } from '@eq/intake'
import { requireUser } from '@/lib/actions/auth'
import { canWrite } from '@/lib/utils/roles'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const MAX_FILES = 4
// 25 MB per PDF — Equinix's WOs run ~1-5 MB but scanned multi-page PDFs
// can balloon. Bigger than that is almost certainly the wrong document.
const MAX_FILE_BYTES = 25 * 1024 * 1024

interface ErrorBody {
  error: string
  detail?: string
}

function jsonError(status: number, body: ErrorBody): NextResponse {
  return NextResponse.json(body, { status })
}

export async function POST(request: NextRequest): Promise<NextResponse<MaximoPdfWoResult | ErrorBody>> {
  let auth
  try {
    auth = await requireUser()
  } catch (e: unknown) {
    return jsonError(401, { error: 'Not authenticated', detail: (e as Error).message })
  }

  if (!canWrite(auth.role)) {
    return jsonError(403, { error: 'Insufficient permissions to import work orders' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return jsonError(500, {
      error: 'Maximo PDF parsing is not configured',
      detail: 'ANTHROPIC_API_KEY is not set on this deployment.',
    })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch (e: unknown) {
    return jsonError(400, { error: 'Invalid multipart body', detail: (e as Error).message })
  }

  const rawFiles = formData.getAll('files')
  if (rawFiles.length === 0) {
    return jsonError(400, { error: 'No files provided. Send one or more PDFs under the "files" key.' })
  }
  if (rawFiles.length > MAX_FILES) {
    return jsonError(400, { error: `Too many files. Maximum is ${MAX_FILES} per request.` })
  }

  const skillFiles: Array<{ bytes: Uint8Array; fileName: string }> = []
  for (const raw of rawFiles) {
    if (!(raw instanceof File)) {
      return jsonError(400, { error: 'All "files" entries must be files, not plain strings.' })
    }
    if (raw.size > MAX_FILE_BYTES) {
      return jsonError(413, {
        error: `File "${raw.name}" exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit.`,
      })
    }
    if (!raw.type.includes('pdf') && !raw.name.toLowerCase().endsWith('.pdf')) {
      return jsonError(415, {
        error: `File "${raw.name}" is not a PDF.`,
        detail: `Got content-type "${raw.type}".`,
      })
    }
    const buf = new Uint8Array(await raw.arrayBuffer())
    skillFiles.push({ bytes: buf, fileName: raw.name })
  }

  const ai = new AnthropicProvider({ apiKey })

  try {
    const result = await parseMaximoPdfWo({ files: skillFiles, ai })
    return NextResponse.json(result)
  } catch (e: unknown) {
    const message = (e as Error).message || 'Unknown error during PDF parse.'
    return jsonError(500, {
      error: 'Failed to parse one or more PDFs',
      detail: message,
    })
  }
}
