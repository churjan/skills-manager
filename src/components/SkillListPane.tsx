import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

const MIN_WIDTH = 220
const MAX_WIDTH = 360
const DETAIL_MIN_WIDTH = 400
const STORAGE_KEY = "skill-list-width"

function readWidth() {
  try {
    const width = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(width) && width >= MIN_WIDTH ? Math.min(width, MAX_WIDTH) : null
  } catch { return null }
}

function rememberWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(width))
  } catch { /* Resizing still works when storage is unavailable. */ }
}

export function SkillListPane({ children }: { children: ReactNode }) {
  const pane = useRef<HTMLElement>(null)
  const grabOffset = useRef(0)
  const [preferred, setPreferred] = useState(readWidth)
  const [viewport, setViewport] = useState(window.innerWidth)
  const [max, setMax] = useState(MAX_WIDTH)
  const [dragging, setDragging] = useState(false)
  const width = Math.round(Math.max(MIN_WIDTH, Math.min(max, preferred ?? Math.min(340, Math.max(244, viewport / 4)))))

  useLayoutEffect(() => {
    function measure() {
      const left = pane.current?.getBoundingClientRect().left ?? 0
      setViewport(window.innerWidth)
      setMax(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(window.innerWidth - left - DETAIL_MIN_WIDTH))))
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [])

  function setWidth(value: number) {
    const next = Math.round(Math.max(MIN_WIDTH, Math.min(max, value)))
    setPreferred(next)
    return next
  }

  return <aside ref={pane} id="skill-list" className="inventory" style={{ width }} aria-labelledby="skill-list-heading">
    {children}
    <div role="separator" aria-orientation="vertical" aria-label="技能列表宽度" aria-controls="skill-list"
      aria-valuemin={MIN_WIDTH} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
      className="list-divider" data-dragging={dragging || undefined}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || !pane.current) return
        grabOffset.current = event.clientX - pane.current.getBoundingClientRect().right
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        event.preventDefault()
      }}
      onPointerMove={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId) && pane.current) {
          setWidth(event.clientX - pane.current.getBoundingClientRect().left - grabOffset.current)
        }
      }}
      onPointerUp={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId) && pane.current) {
          rememberWidth(setWidth(event.clientX - pane.current.getBoundingClientRect().left - grabOffset.current))
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => { setPreferred(null); rememberWidth(null) }}
      onKeyDown={event => {
        const targets: Record<string, number> = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: MIN_WIDTH, End: max }
        if (Object.hasOwn(targets, event.key)) {
          event.preventDefault()
          rememberWidth(setWidth(targets[event.key]))
        }
      }} />
  </aside>
}
