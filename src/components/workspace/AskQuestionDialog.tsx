'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Copy, Loader2, MessageCircleQuestion, Quote, Send, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { CodeBlockPre } from '@/components/common/CodeBlockPre';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import { normalizeMathMarkdown } from '@/lib/markdown-math';
import { useWorkspace } from '@/lib/workspace-store';

interface AskQuestionTurn {
  question: string;
  answer: string;
  quotedText?: string;
}

interface AskQuestionDialogProps {
  open: boolean;
  selectedText: string;
  folderPath: string | null;
  sessionId: string | null;
  model?: string;
  currentPdfPath?: string | null;
  onClose: () => void;
}

function AskMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          code: ({ children, className: codeClassName }) => {
            const isBlock = Boolean(codeClassName);
            if (isBlock) {
              return (
                <code className="block overflow-x-auto rounded-lg bg-surface-container px-3 py-2 font-functional text-xs">
                  {children}
                </code>
              );
            }

            return (
              <code className="rounded bg-surface-container px-1.5 py-0.5 font-functional text-xs">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <CodeBlockPre>{children}</CodeBlockPre>,
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-outline-variant pl-3 text-on-surface-variant last:mb-0">
              {children}
            </blockquote>
          ),
        }}
      >
        {normalizeMathMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}

export function AskQuestionDialog({
  open,
  selectedText,
  folderPath,
  sessionId,
  model,
  currentPdfPath,
  onClose,
}: AskQuestionDialogProps) {
  const { activePdf, screenshot, setScreenshot, screenshotMode, setScreenshotMode } = useWorkspace();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<AskQuestionTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedTurnIndex, setCopiedTurnIndex] = useState<number | null>(null);
  const [quotedText, setQuotedText] = useState<string | null>(null);
  const [quotePopup, setQuotePopup] = useState<{ text: string; top: number; left: number } | null>(null);
  const [awaitingScreenshot, setAwaitingScreenshot] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuestion('');
      setTurns([]);
      setError('');
      setLoading(false);
      setQuotedText(null);
      setQuotePopup(null);
      setAwaitingScreenshot(false);
    }
  }, [open, selectedText]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (awaitingScreenshot) {
          setAwaitingScreenshot(false);
          setScreenshotMode(false);
          return;
        }
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [awaitingScreenshot, onClose, open, setScreenshotMode]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, loading]);

  // While screenshot capture is in progress on the PDF viewer underneath,
  // the dialog hides itself (without unmounting, so turns/question survive)
  // and waits for the viewer to drop out of screenshot mode when done.
  useEffect(() => {
    if (awaitingScreenshot && !screenshotMode) {
      setAwaitingScreenshot(false);
    }
  }, [awaitingScreenshot, screenshotMode]);

  useEffect(() => {
    if (!open || awaitingScreenshot) return;

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!selection || !text || selection.rangeCount === 0) {
        return;
      }

      const anchorNode = selection.anchorNode;
      const container = contentRef.current;
      if (!container || !anchorNode || !container.contains(anchorNode)) {
        return;
      }

      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        return;
      }

      setQuotePopup({
        text,
        top: Math.max(8, rect.top - 36),
        left: Math.min(Math.max(8, rect.left), window.innerWidth - 140),
      });
    };

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-ask-quote-popup="true"]')) return;
      setQuotePopup(null);
    };

    document.addEventListener('mouseup', handleSelectionChange);
    document.addEventListener('keyup', handleSelectionChange);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mouseup', handleSelectionChange);
      document.removeEventListener('keyup', handleSelectionChange);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [awaitingScreenshot, open]);

  if (!open) {
    return null;
  }

  const hasPassage = Boolean(selectedText.trim());

  const handleQuoteSelection = () => {
    if (!quotePopup) return;
    setQuotedText(quotePopup.text);
    setQuotePopup(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleCaptureScreenshot = () => {
    if (!activePdf) return;
    setAwaitingScreenshot(true);
    setScreenshotMode(true);
  };

  const handleAsk = async () => {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || loading || !folderPath || !sessionId) return;

    const activeQuote = quotedText;
    const activeScreenshot = screenshot;
    const promptQuestion = activeQuote
      ? `Regarding this highlighted part: "${activeQuote}"\n\n${trimmedQuestion}`
      : trimmedQuestion;

    setQuestion('');
    setQuotedText(null);
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/chat/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderPath,
          sessionId,
          question: promptQuestion,
          selectedText,
          model,
          currentPdfPath,
          screenshotPath: activeScreenshot?.path || null,
        }),
      });
      const data = await res.json();

      if (!res.ok || data?.error) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to get an answer.');
      }

      setTurns((current) => [
        ...current,
        { question: trimmedQuestion, answer: data.answer as string, quotedText: activeQuote ?? undefined },
      ]);
      if (activeScreenshot) {
        setScreenshot(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get an answer.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyAnswer = async (answer: string, index: number) => {
    try {
      await navigator.clipboard.writeText(answer);
      setCopiedTurnIndex(index);
      window.setTimeout(() => {
        setCopiedTurnIndex((current) => (current === index ? null : current));
      }, 1500);
    } catch {
      // Clipboard access denied or unavailable — nothing to recover here.
    }
  };

  return (
    <div
      className={`fixed inset-0 z-[60] flex items-center justify-center bg-black/35 px-4 py-6 ${
        awaitingScreenshot ? 'pointer-events-none bg-transparent opacity-0' : ''
      }`}
    >
      <div className="flex h-full max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-outline-variant/20 bg-surface-container-lowest shadow-ambient">
        <div className="flex items-start justify-between gap-4 border-b border-outline-variant/15 px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
            <MessageCircleQuestion size={14} strokeWidth={2} />
            Ask about this
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high"
            title="Dismiss"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div ref={contentRef} className="flex-1 overflow-y-auto px-5 py-4">
          {hasPassage && (
            <div className="rounded-xl bg-surface-container px-4 py-3">
              <div className="text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
                Selected passage
              </div>
              <AskMarkdown
                content={selectedText}
                className="chat-markdown font-editorial mt-2 text-sm text-on-surface"
              />
            </div>
          )}

          {screenshot && (
            <div className={`rounded-xl bg-surface-container px-4 py-3 ${hasPassage ? 'mt-3' : ''}`}>
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
                  Screenshot
                </div>
                <button
                  onClick={() => setScreenshot(null)}
                  className="rounded p-0.5 text-on-surface-variant hover:bg-surface-container-high"
                  title="Remove screenshot"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
              <img
                src={screenshot.dataUrl}
                alt="Captured screenshot"
                className="mt-2 max-h-64 w-full rounded-lg object-contain"
              />
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {error}
            </div>
          )}

          <div className="mt-4 space-y-4">
            {turns.map((turn, index) => (
              <div key={index} className="space-y-2">
                {turn.quotedText && (
                  <div className="flex justify-end">
                    <div className="max-w-[90%] rounded-lg border-l-2 border-primary/50 bg-surface-container px-2.5 py-1.5 text-xs italic text-on-surface-variant">
                      &ldquo;{turn.quotedText}&rdquo;
                    </div>
                  </div>
                )}
                <div className="flex justify-end">
                  <div className="max-w-[90%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm text-on-primary">
                    {turn.question}
                  </div>
                </div>
                <AskMarkdown content={turn.answer} className="chat-markdown font-editorial text-sm text-on-surface" />
                <button
                  onClick={() => void handleCopyAnswer(turn.answer, index)}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high"
                >
                  {copiedTurnIndex === index ? (
                    <Check size={10} strokeWidth={2} />
                  ) : (
                    <Copy size={10} strokeWidth={2} />
                  )}
                  {copiedTurnIndex === index ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                <Loader2 size={12} className="animate-spin" />
                Thinking...
              </div>
            )}

            {turns.length === 0 && !loading && (
              <p className="text-xs text-on-surface-variant">
                {hasPassage
                  ? 'Ask anything about the passage above — the full PDF and chat history are used as context. Select any text here to quote it, or attach a screenshot from the PDF.'
                  : 'Ask anything about the screenshot above, or attach one from the PDF — the full PDF and chat history are used as context.'}
              </p>
            )}
          </div>

          <div ref={endRef} />
        </div>

        {quotedText && (
          <div className="flex flex-wrap gap-2 border-t border-outline-variant/15 px-5 pt-3">
            <div className="flex max-w-full items-center gap-1.5 rounded-lg bg-surface-container px-2.5 py-1.5 text-xs text-on-surface-variant">
              <Quote size={11} strokeWidth={2} className="shrink-0" />
              <span className="truncate italic">{quotedText}</span>
              <button
                onClick={() => setQuotedText(null)}
                className="shrink-0 rounded p-0.5 hover:bg-surface-container-high"
                title="Remove quote"
              >
                <X size={10} strokeWidth={2} />
              </button>
            </div>
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-outline-variant/15 px-5 py-3">
          <button
            onClick={handleCaptureScreenshot}
            disabled={!activePdf || loading}
            title={activePdf ? 'Attach a screenshot region from the PDF' : 'Open a PDF to attach a screenshot'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-40"
          >
            <Camera size={14} strokeWidth={2} />
          </button>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleAsk();
              }
            }}
            placeholder="What does this mean?"
            rows={1}
            disabled={!folderPath || !sessionId}
            className="flex-1 resize-none rounded-xl bg-surface-container-low px-3 py-2.5 text-sm text-on-surface outline-none placeholder:text-outline disabled:opacity-60"
          />
          <button
            onClick={() => void handleAsk()}
            disabled={loading || !question.trim() || !folderPath || !sessionId}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Send size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      {quotePopup && (
        <button
          data-ask-quote-popup="true"
          onClick={handleQuoteSelection}
          style={{ position: 'fixed', top: quotePopup.top, left: quotePopup.left, zIndex: 70 }}
          className="flex items-center gap-1 rounded-full bg-on-surface px-2.5 py-1.5 text-[11px] font-medium text-surface-container-lowest shadow-ambient"
        >
          <Quote size={10} strokeWidth={2} />
          Quote
        </button>
      )}
    </div>
  );
}
