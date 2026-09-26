'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

export function CodeBlockPre({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = preRef.current?.textContent?.replace(/\n$/, '') ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="group relative mb-3 last:mb-0">
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label="Copy code"
        title="Copy code"
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-1 text-[10px] font-medium text-on-surface-variant opacity-70 shadow-sm transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check size={10} strokeWidth={2} /> : <Copy size={10} strokeWidth={2} />}
        {copied ? 'Copied' : 'Copy code'}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
