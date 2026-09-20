# Native dependency patches

`npm ci` applies `patches/` through `patch-package --error-on-fail`. Native
acceptance and store builds both use this install path. A failed patch stops the
install; do not skip lifecycle scripts for a build. The patch tool is a regular
dependency so this also works when development dependencies are omitted.

Expo's fingerprint includes `patches/`. These fixes require a new native store
build; publishing an OTA cannot change Android classes in an installed app.

## react-native-screens 4.16.0: Android refresh-control removal

Backport of [upstream PR 4519](https://github.com/software-mansion/react-native-screens/pull/4519),
merged as `8a697f8bcb198ee9655502259fe160c8892ff918` and released in 4.28.0.
Keep Expo SDK 54's compatible screens version pinned to 4.16.0 while this patch
is needed. Remove the patch when upgrading to an Expo-compatible version that
includes the upstream fix, and rerun both native acceptance platforms.

`Screen.startTransitionRecursive` adds a filler to Android's `SwipeRefreshLayout`
when removing a screen. Inserting it before the progress circle increases the
circle index cached by measurement. Removing content before the next measure can
then leave that index equal to the child count, crashing the next draw with
`getChildDrawingOrder() returned invalid index 2 (child count is 2)`.

Append the filler instead. This preserves its purpose while avoiding the inflated
cached index. The backport changes only that Android insertion call; it changes
no JavaScript API, native interface, iOS behavior, or runtime compatibility.
Filler cleanup remains an upstream limitation; this patch does not introduce
additional fillers or attempt a separate lifecycle rewrite.

Native acceptance reproduced the crash during the third account-switch round on
the unpatched dependency. Its five round trips retain live WebViews, account
isolation and working terminal input checks; all remain required after patching.
