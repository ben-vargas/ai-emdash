import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Attachment = {
  id: string;
  file: File;
  previewUrl: string;
};

export function useAttachments() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const nextAttachmentIdRef = useRef(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const setAttachmentList = useCallback((updater: (prev: Attachment[]) => Attachment[]) => {
    setAttachments((prev) => {
      const next = updater(prev);
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        const attachmentsToAdd = files.map((file) => ({
          id: `${file.name}-${file.lastModified}-${nextAttachmentIdRef.current++}`,
          file,
          previewUrl: URL.createObjectURL(file),
        }));
        setAttachmentList((prev) => [...prev, ...attachmentsToAdd]);
      }
    },
    [setAttachmentList]
  );

  const removeAttachment = useCallback(
    (index: number) => {
      const removed = attachmentsRef.current[index];
      setAttachmentList((prev) => prev.filter((_, i) => i !== index));
      if (removed) URL.revokeObjectURL(removed.previewUrl);
    },
    [setAttachmentList]
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(event.target.files ?? []));
      event.target.value = '';
    },
    [addFiles]
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      addFiles(imageFiles);
    },
    [addFiles]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      addFiles(files.filter((file) => file.type.startsWith('image/')));
    },
    [addFiles]
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, []);

  const reset = useCallback(() => {
    attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    attachmentsRef.current = [];
    setAttachments([]);
    dragCounterRef.current = 0;
    setIsDraggingOver(false);
  }, []);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      attachmentsRef.current = [];
    };
  }, []);

  return {
    attachments,
    isDraggingOver,
    fileInputRef,
    removeAttachment,
    openFilePicker,
    handleFileInputChange,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    reset,
  };
}
