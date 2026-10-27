import { NextRequest, NextResponse } from 'next/server';
import { appendMessage, getSession, updateSession } from '@/lib/annot-sessions';
import { getProviderRuntime } from '@/lib/ai-providers';
import { createPdfNote } from '@/lib/pdf-notes';
import { MAX_ATTACHMENTS, MAX_SCREENSHOTS } from '@/lib/screenshot-limits';
import { appendNoteSavedConfirmation, extractNoteDirective } from '@/lib/note-directive';
import { extractGotoDirective } from '@/lib/goto-directive';
import { buildEditContext, processEditReply } from '@/lib/pdf-edit/chat-integration';
import { cleanLocation, documentTextPathFor } from '@/lib/document-context';

const EDIT_MODEL = 'sonnet';
const EDIT_EFFORT = 'low' as const;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      folderPath,
      sessionId,
      prompt,
      model,
      currentPdfPath,
      selectedText,
      currentPage,
      currentLocation,
      screenshotPaths,
      attachmentPaths,
      editMode,
      autoApplyNarrow,
    } = body as {
      folderPath?: string;
      sessionId?: string;
      prompt?: string;
      model?: string;
      currentPdfPath?: string | null;
      selectedText?: string | null;
      currentPage?: number | null;
      currentLocation?: string | null;
      screenshotPaths?: string[] | null;
      attachmentPaths?: string[] | null;
      editMode?: boolean;
      autoApplyNarrow?: boolean;
    };

    if (!folderPath || !sessionId || !prompt?.trim()) {
      return NextResponse.json(
        { error: 'folderPath, sessionId, and prompt are required' },
        { status: 400 }
      );
    }

    const session = await getSession(folderPath, sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    const userMessage = {
      id: `u-${Date.now()}`,
      role: 'user' as const,
      content: prompt.trim(),
      timestamp: new Date().toISOString(),
    };
    const runtime = getProviderRuntime(session.provider);
    const resolvedModel = model || session.model || (await runtime.listModels())[0]?.id;

    if (!resolvedModel) {
      return NextResponse.json(
        { error: `No models available for provider "${session.provider}"` },
        { status: 400 }
      );
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const writeEvent = (payload: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        };

        void (async () => {
          try {
            const resolvedPdfPath = currentPdfPath ?? session.pdfPath ?? null;
            const edit = await buildEditContext({
              pdfPath: resolvedPdfPath,
              provider: session.provider,
              prompt: prompt.trim(),
              editMode: editMode === true,
            });
            // While the assistant is editing the PDF (including repair rounds), Claude runs Sonnet at low effort.
            // Everything else keeps the user's chosen model and the default effort.
            const editingWithClaude = edit.allowed && session.provider === 'claude';
            const turnModel = editingWithClaude ? EDIT_MODEL : resolvedModel;
            const documentTextPath = await documentTextPathFor(resolvedPdfPath);
            const turnInput = {
              model: turnModel,
              ...(editingWithClaude ? { effort: EDIT_EFFORT } : {}),
              folderPath,
              sessionKind: session.sessionKind,
              currentPdfPath: resolvedPdfPath,
              selectedText: selectedText ?? null,
              currentPage: Number.isInteger(currentPage) && Number(currentPage) >= 1 ? Number(currentPage) : null,
              documentTextPath,
              currentLocation: documentTextPath ? cleanLocation(currentLocation) : null,
              screenshotPaths: Array.isArray(screenshotPaths)
                ? screenshotPaths.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_SCREENSHOTS)
                : [],
              attachmentPaths: Array.isArray(attachmentPaths)
                ? attachmentPaths.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_ATTACHMENTS)
                : [],
              edit: edit.prompt,
            };
            const turn = await runtime.runTurn({
              ...turnInput,
              providerSessionId: session.providerSessionId,
              prompt: prompt.trim(),
            }, {
              onEvent: (event) => {
                writeEvent(event);
              },
            });

            // A PDF edit proposal is validated and stored as a preview; the PDF itself is not touched here.
            const editResult = resolvedPdfPath
              ? await processEditReply({
                content: turn.content,
                providerSessionId: turn.providerSessionId,
                edit,
                pdfPath: resolvedPdfPath,
                sessionId,
                userPrompt: prompt.trim(),
                autoApplyNarrow: autoApplyNarrow === true,
                runtime,
                turnInput,
                onEvent: (event) => writeEvent(event),
              })
              : { content: turn.content, providerSessionId: turn.providerSessionId, proposalId: undefined };

            const { cleanedContent: withoutGoto, page: gotoPage } = extractGotoDirective(editResult.content);
            const { cleanedContent, note } = extractNoteDirective(withoutGoto);
            let finalContent = cleanedContent;

            if (note && resolvedPdfPath) {
              await createPdfNote(resolvedPdfPath, note.title, note.body);
              finalContent = appendNoteSavedConfirmation(cleanedContent, note.title);
            }

            const assistantMessage = {
              id: `a-${Date.now()}`,
              role: 'assistant' as const,
              content: finalContent,
              timestamp: new Date().toISOString(),
              model: turnModel,
              ...(editResult.proposalId ? { proposalId: editResult.proposalId } : {}),
            };

            const nextMessages = appendMessage(
              appendMessage(session.messages, userMessage),
              assistantMessage,
            );

            const messageSavedSession = await updateSession(folderPath, sessionId, {
              messages: nextMessages,
              provider: session.provider,
              providerSessionId: editResult.providerSessionId,
              model: resolvedModel,
            });

            writeEvent({
              type: 'final',
              content: assistantMessage.content,
              ...(gotoPage ? { gotoPage } : {}),
              model: assistantMessage.model,
              provider: session.provider,
              session: messageSavedSession,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Internal server error';
            writeEvent({ type: 'error', message });
          } finally {
            controller.close();
          }
        })();
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
