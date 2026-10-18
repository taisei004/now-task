import { useEffect, useRef, useState } from "react";
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: {
        results: ArrayLike<{
          isFinal: boolean;
          [index: number]: { transcript: string };
        }>;
        resultIndex: number;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type VoiceWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
export function useVoiceInput(
  append: (text: string) => void,
  notice: (text: string) => void,
  scope: string,
) {
  const [listening, setListening] = useState(false),
    [interim, setInterim] = useState("");
  const current = useRef<Recognition | null>(null),
    appendRef = useRef(append),
    noticeRef = useRef(notice);
  appendRef.current = append;
  noticeRef.current = notice;
  const Constructor =
    (window as VoiceWindow).SpeechRecognition ??
    (window as VoiceWindow).webkitSpeechRecognition;
  useEffect(
    () => () => {
      if (current.current) {
        current.current.onresult = null;
        current.current.onerror = null;
        current.current.onend = null;
        current.current.abort();
      }
      current.current = null;
      setListening(false);
      setInterim("");
    },
    [scope],
  );
  const toggle = () => {
    if (listening) {
      current.current?.stop();
      return;
    }
    if (!Constructor) {
      noticeRef.current(
        "このブラウザは音声認識に対応していません。端末のキーボードのマイクも使えます。",
      );
      return;
    }
    const recognition = new Constructor();
    current.current = recognition;
    recognition.lang = "ja-JP";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (e) => {
      let partial = "",
        final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) final += result[0].transcript;
        else partial += result[0].transcript;
      }
      if (final) appendRef.current(final);
      setInterim(partial);
    };
    recognition.onerror = (e) => {
      setListening(false);
      setInterim("");
      noticeRef.current(
        e.error === "not-allowed"
          ? "マイクの利用が許可されていません。ブラウザのサイト設定をご確認ください。"
          : e.error === "no-speech"
            ? "音声を聞き取れませんでした。もう一度お試しください。"
            : "音声認識を開始できませんでした。",
      );
    };
    recognition.onend = () => {
      setListening(false);
      setInterim("");
    };
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
      noticeRef.current("音声入力を開始できませんでした。");
    }
  };
  return { listening, interim, supported: !!Constructor, toggle };
}
