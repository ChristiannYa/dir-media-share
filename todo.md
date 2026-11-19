## Definitions

`mip`: modify in progess menu
`modify`: edited, compressed, or both

---

The todos in each section are sorted by priority: top = highest;

---

# Fix

- opening a video in a carousel/fullscreen should remove it from the `mip`
- when editing and compressing at the same time in the same job, the compress
  should occur first and then the edit
- `modify`ing a media that replaces the original should inherit the original's
  metadata: love count, watch count, most viewed sections, and so on
- going back to an already encoded media encodes it again

# Ui

- reduced opacity on carousel cards that are not playing
- `mip` items should replace the edit|compress|edit+compress text badges into
  icons
- make `mip` have folder names as sticky headers

# Feature

- make `consts/compress.ts`'s a configurable value
- all media cards show have a banner showing if a compression has already been
  made
- `mip` items should always show what they're queued for (`modify`)
- modified items in the gallery: when clicking any of their `modify` badge, if
  their original copy is not found, pop up a message saying so or a snacks
  message; whatever reuses code for notifications, instead of opening the
  media
- add a status indicator (loading, done, failed) on anything that does
  operations on the server laptop (clearing cache, renaming, etc)
- add card's right click menu on carousel as well
- add a "clear" button to items on the `mip`
- add large pulsating red color around the screen when the lock timer is about
  to run out. it should show above everything, even fullscreen
- hovering (tapping, on touch devices) over the lock button should show two
  options: lock and add time
- upload queue
- video quality enhancer

# Check if

- while an image's `modify`, will deleting it (the original) affect the
  ongoing editions? it should not
- multiple `mip`' can be done simultaneously. it should not (i think)
- resetting a video's play count would also reset the most viewed sections
  stats. it should so
