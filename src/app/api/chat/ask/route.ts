import { documentTextPathFor } from '@/lib/document-context';
import { NextRequest, NextResponse } from 'next/server';

import { getSession } from '@/lib/annot-sessions';
import { getProviderRuntime } from '@/lib/ai-providers';
import { createPdfNote } from '@/lib/pdf-notes';
import { MAX_SCREENSHOTS } from '@/lib/screenshot-limits';
import { appendNoteSavedConfirmation, extractNoteDirective } from '@/lib/note-directive';
import { extractGotoDirective } from '@/lib/goto-directive';

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
      screenshotPaths,
    } = body as {
      folderPath?: string;
      sessionId?: string;
      question?: string;
      selectedText?: string;
      model?: string;
      currentPdfPath?: string | null;
      screenshotPaths?: string[] | null;
    };

    const trimmedSelectedText = selectedText?.trim() || '';
    const validScreenshotPaths = Array.isArray(screenshotPaths)
      ? screenshotPaths.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_SCREENSHOTS)
      : [];
    if (!folderPath || !sessionId || !question?.trim() || (!trimmedSelectedText && validScreenshotPaths.length === 0)) {
      return NextResponse.json(
        { error: 'folderPath, sessionId, question, and either selectedText or screenshotPaths are required' },
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
    const resolvedPdfPath = currentPdfPath ?? session.pdfPath ?? null;
    const focusDescription = trimmedSelectedText
      ? 'a passage from your previous reply'
      : validScreenshotPaths.length > 1
        ? 'screenshot regions the user just captured'
        : 'a screenshot region the user just captured';
    const turn = await runtime.runTurn({
      providerSessionId: session.providerSessionId,
      model: resolvedModel,
      folderPath,
      prompt: `The user is asking a follow-up about ${focusDescription} — this may be a clarifying question, or a request to save something as a note (in which case follow the note-saving directive above). Focus on that.\n\nRequest: ${question.trim()}`,
      sessionKind: session.sessionKind,
      currentPdfPath: resolvedPdfPath,
      documentTextPath: await documentTextPathFor(resolvedPdfPath),
      selectedText: trimmedSelectedText || null,
      screenshotPaths: validScreenshotPaths,
    });

    // Side Q&A has no page to navigate; just keep a stray go-to block out of the visible answer.
    const { cleanedContent, note } = extractNoteDirective(extractGotoDirective(turn.content).cleanedContent);
    let finalAnswer = cleanedContent;

    if (note && resolvedPdfPath) {
      await createPdfNote(resolvedPdfPath, note.title, note.body);
      finalAnswer = appendNoteSavedConfirmation(cleanedContent, note.title);
    }

    return NextResponse.json({ answer: finalAnswer }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
