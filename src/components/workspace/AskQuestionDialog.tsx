'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircleQuestion, Send, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import { normalizeMathMarkdown } from '@/lib/markdown-math';

interface AskQuestionTurn {
  question: string;
  answer: string;
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

export function AskQuestionDialog({
  open,
  selectedText,
  folderPath,
  sessionId,
  model,
  currentPdfPath,
  onClose,
}: AskQuestionDialogProps) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<AskQuestionTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuestion('');
      setTurns([]);
      setError('');
      setLoading(false);
    }
  }, [open, selectedText]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, loading]);

  if (!open) {
    return null;
  }

  const handleAsk = async () => {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || loading || !folderPath || !sessionId) return;

    setQuestion('');
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/chat/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderPath,
          sessionId,
          question: trimmedQuestion,
          selectedText,
          model,
          currentPdfPath,
        }),
      });
      const data = await res.json();

      if (!res.ok || data?.error) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to get an answer.');
      }

      setTurns((current) => [...current, { question: trimmedQuestion, answer: data.answer as string }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get an answer.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 px-4 py-6">
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-xl bg-surface-container px-4 py-3">
            <div className="text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
              Selected passage
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-on-surface">
              {selectedText}
            </p>
          </div>

          {error && (
            <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {error}
            </div>
          )}

          <div className="mt-4 space-y-4">
            {turns.map((turn, index) => (
              <div key={index} className="space-y-2">
                <div className="flex justify-end">
                  <div className="max-w-[90%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm text-on-primary">
                    {turn.question}
                  </div>
                </div>
                <div className="chat-markdown font-editorial text-sm text-on-surface">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                      ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
                      ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
                      li: ({ children }) => <li>{children}</li>,
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      code: ({ children, className }) => {
                        const isBlock = Boolean(className);
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
                      pre: ({ children }) => <pre className="mb-3 last:mb-0">{children}</pre>,
                      blockquote: ({ children }) => (
                        <blockquote className="mb-3 border-l-2 border-outline-variant pl-3 text-on-surface-variant last:mb-0">
                          {children}
                        </blockquote>
                      ),
                    }}
                  >
                    {normalizeMathMarkdown(turn.answer)}
                  </ReactMarkdown>
                </div>
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
                Ask anything about the passage above — the full PDF and chat history are used as context.
              </p>
            )}
          </div>

          <div ref={endRef} />
        </div>

        <div className="flex items-end gap-2 border-t border-outline-variant/15 px-5 py-3">
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
    </div>
  );
}
