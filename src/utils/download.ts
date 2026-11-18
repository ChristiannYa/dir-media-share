/**
 * Saves the file at `url` (same origin) to the device as `name`, instead of
 * opening it: a link with the download attribute, clicked and thrown away
 */
export function downloadFile(url: string, name: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
}
