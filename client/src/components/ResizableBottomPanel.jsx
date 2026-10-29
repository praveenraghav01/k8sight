import React, { forwardRef, useRef, useState } from 'react';

const MIN_HEIGHT = 20;
const MAX_HEIGHT = 80;

const ResizableBottomPanel = forwardRef(function ResizableBottomPanel({
  className = '',
  position = 'bottom',
  label = 'Resize bottom panel',
  children
}, panelRef) {
  const [height, setHeight] = useState(42);
  const resizeRef = useRef(null);

  const startResize = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const containerHeight = event.currentTarget.parentElement?.getBoundingClientRect().height || window.innerHeight;
    resizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height,
      containerHeight
    };
  };

  const moveResize = (event) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const nextHeight = resize.startHeight + ((resize.startY - event.clientY) / resize.containerHeight) * 100;
    setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, nextHeight)));
  };

  const stopResize = (event) => {
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
  };

  const resizeWithKeyboard = (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? 2 : -2;
    setHeight((current) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, current + delta)));
  };

  return (
    <>
      {position === 'bottom' && (
        <div
          className="bottom-panel-resize-handle"
          role="separator"
          aria-label={label}
          aria-orientation="horizontal"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          aria-valuenow={Math.round(height)}
          title="Drag to resize panel"
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
          onKeyDown={resizeWithKeyboard}
        />
      )}
      <div
        ref={panelRef}
        className={`bottom-panel ${className}`.trim()}
        style={position === 'bottom' ? { height: `${height}%`, flex: `0 0 ${height}%`, minHeight: 0 } : undefined}
      >
        {children}
      </div>
    </>
  );
});

export default ResizableBottomPanel;
