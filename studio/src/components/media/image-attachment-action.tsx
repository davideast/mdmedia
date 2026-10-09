"use client";

import { useRef } from "react";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Uses native file selection; callers own validation, assets, and their lifecycle. */
export function ImageAttachmentAction({ label, multiple = false, onFiles, className }: {
  label: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple={multiple}
        className="hidden" aria-label={label} onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          if (files.length) onFiles(files);
          event.currentTarget.value = "";
        }} />
      <Button type="button" variant="outline" size="sm" className={className} onClick={() => input.current?.click()}>
        <ImagePlus size={14} />{label}
      </Button>
    </>
  );
}
