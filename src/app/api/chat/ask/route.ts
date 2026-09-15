import { NextRequest, NextResponse } from 'next/server';

import { getSession } from '@/lib/annot-sessions';
import { getProviderRuntime } from '@/lib/ai-providers';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      folderPath,
      sessionId,
      question,
      selectedText,
      model,
      currentPdfPath,
    } = body as {
      folderPath?: string;
      sessionId?: string;
      question?: string;
      selectedText?: string;
      model?: string;
      currentPdfPath?: string | null;
    };

    if (!folderPath || !sessionId || !question?.trim() || !selectedText?.trim()) {
      return NextResponse.json(
        { error: 'folderPath, sessionId, question, and selectedText are required' },
        { status: 400 },
      );
    }

    const session = await getSession(folderPath, sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const runtime = getProviderRuntime(session.provider);
    const resolvedModel = model || session.model || (await runtime.listModels())[0]?.id;

    if (!resolvedModel) {
      return NextResponse.json(
        { error: `No models available for provider "${session.provider}"` },
        { status: 400 },
      );
    }

    // Resumes the existing provider session so the full PDF + chat history is
    // available as context, without persisting this side Q&A into the visible
    // chat transcript.
    const turn = await runtime.runTurn({
      providerSessionId: session.providerSessionId,
      model: resolvedModel,
      folderPath,
      prompt: `The user is asking a clarifying question about a passage from your previous reply. Answer only the question below, focused on that passage.\n\nQuestion: ${question.trim()}`,
      sessionKind: session.sessionKind,
      currentPdfPath: currentPdfPath ?? session.pdfPath ?? null,
      selectedText: selectedText.trim(),
      screenshotPath: null,
    });

    return NextResponse.json({ answer: turn.content }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
