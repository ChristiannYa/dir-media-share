## Definitions

`mip`: modify in progess menu
`modify`: edited, compressed, or both

# Fix

- going back to an alraedy encoded media encodes it again
- opening a video in a carousel/fullscreen should remove it from the `mip`
- when editing and compressing at the same time in the same job, the compress
  should occur first and then the edit

# Ui

- reduced opacity on carousel cards that are not playing
- make `mip` have folder names as sticky headers
- `mip` items should replace the edit|compress|edit+compress text badges into
  icons

# Feature

- video quality enhancer
- upload queue
- compress and replace
- `modify` badge on media, not folders, show if a `modify` replaced original or
  kept a copy
- `mip` items should always show what they're queued for (`modify`)
- modified items in the gallery: when clicking their `modify` badge, if their
  original copy is not found, pop up a message saying so or a snacks message;
  whatever reuses code for notifications, instead of opening the media
- add card's right click menu on carousel as well
- add a status indicator (loading, done, failed) on anything that does
  operations on the server laptop (clearing cache, renaming, etc)
- add a "clear" button to items on the `mip`
- add large pulsating red color around the screen when the lock timer is about
  to run out. it should show above everything, even fullscreen
- add a time increase on the lock when clicking on it: right click on the clock
  should now show 2 options: lock and add time (prev featurei)

# Check if

- resetting a video's play count should also reset the most viewed sections
  stats. it should so
- while an image's `modify`, will deleting it (the original) affect the
  ongoing editions? it should not
- multiple `mip`' can be done simultaneously. it should not (i think)
