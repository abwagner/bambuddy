import { Camera, ImagePlus, ScanBarcode, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface DetectedBarcode {
  rawValue: string;
}

interface BrowserBarcodeDetector {
  detect(source: unknown): Promise<DetectedBarcode[]>;
}

type BrowserBarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BrowserBarcodeDetector;

function detectorConstructor(): BrowserBarcodeDetectorConstructor | null {
  return (window as Window & { BarcodeDetector?: BrowserBarcodeDetectorConstructor }).BarcodeDetector ?? null;
}

interface BarcodeScannerModalProps {
  onDetected: (barcode: string) => void;
  onClose: () => void;
}

export function BarcodeScannerModal({ onDetected, onClose }: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [manualCode, setManualCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanningPhoto, setScanningPhoto] = useState(false);

  const finish = useCallback((raw: string) => {
    const cleaned = raw.trim();
    if (cleaned) onDetected(cleaned);
  }, [onDetected]);

  useEffect(() => {
    const Detector = detectorConstructor();
    if (!Detector) {
      setError('Automatic barcode detection is not available in this browser. Enter the code below.');
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let detecting = false;
    const detector = new Detector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'data_matrix'],
    });

    void navigator.mediaDevices?.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    }).then(async (cameraStream) => {
      if (cancelled) {
        cameraStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = cameraStream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = cameraStream;
      await videoRef.current.play();
      timer = window.setInterval(async () => {
        if (detecting || !videoRef.current || videoRef.current.readyState < 2) return;
        detecting = true;
        try {
          const results = await detector.detect(videoRef.current);
          if (!cancelled && results[0]?.rawValue) finish(results[0].rawValue);
        } catch {
          // A frame can be unavailable while the camera changes exposure.
          // Keep scanning; persistent camera failures are surfaced by play().
        } finally {
          detecting = false;
        }
      }, 400);
    }).catch((cause) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : 'Could not open the camera. Enter the barcode below.');
      }
    });

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [finish]);

  const scanPhoto = async (file: File | undefined) => {
    if (!file) return;
    const Detector = detectorConstructor();
    if (!Detector || typeof createImageBitmap !== 'function') {
      setError('This browser cannot scan a barcode from a photo. Enter the code below.');
      return;
    }
    setScanningPhoto(true);
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const results = await new Detector().detect(bitmap);
        if (results[0]?.rawValue) finish(results[0].rawValue);
        else setError('No barcode was found in that photo. Try a closer, well-lit image.');
      } finally {
        bitmap.close();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that photo.');
    } finally {
      setScanningPhoto(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl">
        <div className="flex items-center justify-between border-b border-bambu-dark-tertiary p-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
            <ScanBarcode className="h-5 w-5" /> Scan filament barcode
          </h3>
          <button type="button" onClick={onClose} className="p-1 text-bambu-gray hover:text-white" aria-label="Close barcode scanner">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-4">
          <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
            <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
            <div className="pointer-events-none absolute inset-[18%] rounded border-2 border-bambu-green/80" />
            <Camera className="absolute bottom-2 right-2 h-5 w-5 text-white/70" />
          </div>
          {error && <p className="text-sm text-amber-300" role="status">{error}</p>}
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-bambu-dark-tertiary px-3 py-2 text-sm text-bambu-gray hover:text-white">
            <ImagePlus className="h-4 w-4" />
            {scanningPhoto ? 'Scanning photo…' : 'Scan from a photo'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              disabled={scanningPhoto}
              onChange={(event) => void scanPhoto(event.target.files?.[0])}
            />
          </label>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              finish(manualCode);
            }}
          >
            <input
              value={manualCode}
              onChange={(event) => setManualCode(event.target.value)}
              placeholder="UPC, EAN, Code 128…"
              aria-label="Barcode"
              className="min-w-0 flex-1 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white"
            />
            <button
              type="submit"
              disabled={!manualCode.trim()}
              className="rounded-md bg-bambu-green px-3 py-2 text-sm font-medium text-bambu-dark disabled:opacity-50"
            >
              Use code
            </button>
          </form>
          <p className="text-xs text-bambu-gray/70">
            Known codes prefill the filament, color, weight, and slicer preset. An unknown code is learned when you save this spool.
          </p>
        </div>
      </div>
    </div>
  );
}
