import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpeechItem } from '@/lib/speech-text';

export type SpeechStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

async function fetchSpeechUrl(text: string): Promise<string> {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`TTS request failed (${response.status})`);
  return URL.createObjectURL(await response.blob());
}

// Plays a list of text pieces one after another. The next piece is requested while the current
// one plays, so pause/resume only has to control a single <audio> element.
export function useSpeechPlayer() {
  const [status, setStatus] = useState<SpeechStatus>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const runRef = useRef(0);
  const finishCurrentRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    runRef.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    finishCurrentRef.current?.();
    finishCurrentRef.current = null;
    setStatus('idle');
  }, []);

  const start = useCallback(
    async (items: SpeechItem[]) => {
      stop();
      if (items.length === 0) {
        setStatus('error');
        return;
      }

      const run = runRef.current;
      const isCurrent = () => runRef.current === run;
      const urls: Promise<string>[] = [];
      const urlFor = (index: number): Promise<string> | undefined => {
        if (index < items.length && !urls[index]) {
          urls[index] = fetchSpeechUrl(items[index].text);
          urls[index].catch(() => undefined);
        }
        return urls[index];
      };

      setStatus('loading');

      try {
        for (let index = 0; index < items.length; index += 1) {
          const url = await urlFor(index);
          if (!url || !isCurrent()) {
            if (url) URL.revokeObjectURL(url);
            return;
          }
          void urlFor(index + 1);

          const audio = new Audio(url);
          audioRef.current = audio;
          await new Promise<void>((resolve, reject) => {
            finishCurrentRef.current = resolve;
            audio.onended = () => resolve();
            audio.onerror = () => reject(new Error('Audio playback failed'));
            audio.onpause = () => {
              if (isCurrent() && !audio.ended) setStatus('paused');
            };
            audio.onplaying = () => {
              if (isCurrent()) setStatus('playing');
            };
            audio.play().catch(reject);
          });
          URL.revokeObjectURL(url);
          if (!isCurrent()) return;
        }
        stop();
      } catch (error) {
        console.error(error);
        if (isCurrent()) setStatus('error');
      }
    },
    [stop],
  );

  const pause = useCallback(() => audioRef.current?.pause(), []);
  const resume = useCallback(() => void audioRef.current?.play(), []);

  useEffect(() => stop, [stop]);

  return { status, start, pause, resume, stop };
}
