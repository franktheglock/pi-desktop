;(() => {
  const tokenEl = document.getElementById('token')
  const go = document.getElementById('go')
  const err = document.getElementById('err')
  const q = new URLSearchParams(location.search).get('token')
  if (q) tokenEl.value = q

  async function submit() {
    const token = tokenEl.value.trim()
    if (!token) {
      err.hidden = false
      err.textContent = 'Token required'
      return
    }
    go.disabled = true
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Invalid token')
      try {
        localStorage.setItem('pi_lan_token', token)
      } catch (_) {}
      location.href = '/?token=' + encodeURIComponent(token)
    } catch (e) {
      err.hidden = false
      err.textContent = e.message || String(e)
    } finally {
      go.disabled = false
    }
  }

  go.addEventListener('click', () => void submit())
  tokenEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })
})()
