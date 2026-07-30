import { useCallback, useEffect, useRef, useState } from "react";

interface UseQrScannerOptions {
  onDecode(text: string): void;
}

async function waitForVideoElement(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  attempts = 45,
  delayMs = 50,
): Promise<HTMLVideoElement | null> {
  for (let index = 0; index < attempts; index += 1) {
    const video = videoRef.current;
    if (video) return video;
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, delayMs);
    });
  }
  return videoRef.current;
}

export function useQrScanner({ onDecode }: UseQrScannerOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<{
    stop(): void;
    destroy(): void;
    start(): Promise<void>;
  } | null>(null);
  const onDecodeRef = useRef(onDecode);
  const [isActive, setIsActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  const stop = useCallback(() => {
    scannerRef.current?.stop();
    scannerRef.current?.destroy();
    scannerRef.current = null;
    setIsActive(false);
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (!window.isSecureContext) {
      setErrorMessage("QR scanning requires HTTPS (or localhost).");
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage("This browser does not support camera scanning.");
      return false;
    }

    const video = await waitForVideoElement(videoRef);
    if (!video) {
      setErrorMessage("Scanner is not ready yet. Try again.");
      return false;
    }

    stop();

    try {
      const { default: QrScanner } = await import("qr-scanner");
      const scanner = new QrScanner(
        video,
        (result: string | { data: string }) => {
          const text = typeof result === "string" ? result : result.data;
          onDecodeRef.current(text);
        },
        {
          preferredCamera: "environment",
          maxScansPerSecond: 8,
          returnDetailedScanResult: true,
        },
      );

      scannerRef.current = scanner;
      await scanner.start();
      setErrorMessage(null);
      setIsActive(true);
      return true;
    } catch {
      setErrorMessage(
        "Unable to access camera for QR scanning. Check permissions and try again.",
      );
      stop();
      return false;
    }
  }, [stop]);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return {
    videoRef,
    isActive,
    errorMessage,
    start,
    stop,
  };
}
