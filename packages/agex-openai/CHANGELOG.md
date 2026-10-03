# @agex-ts/openai

## 4.0.0

### Minor Changes

- e45bc52: Add opt-in native reasoning to the Chat Completions client. The provider now
  supports `nativeThinking` and `reasoningEffort`, strips schema-level narration
  when native mode is active, normalizes common streamed reasoning extensions,
  replays visible reasoning text across tool turns, and losslessly retains
  uncodex encrypted reasoning items in hidden agex thinking signatures.
- 7bad540: Add a provider-native action surface that keeps `ts_action` dynamic while delegating shell and file operations to provider tools.

### Patch Changes

- Updated dependencies [12219da]
- Updated dependencies [0ab568e]
- Updated dependencies [6aef3c1]
- Updated dependencies [6e9a4c3]
- Updated dependencies [7bad540]
- Updated dependencies [7bad540]
  - agex-ts@0.5.0

## 3.0.0

### Patch Changes

- Updated dependencies [af6de76]
  - agex-ts@0.4.0

## 2.0.0

### Patch Changes

- Updated dependencies [1a9df08]
  - agex-ts@0.3.0

## 1.0.0

### Patch Changes

- Updated dependencies [da49328]
- Updated dependencies [82856bb]
- Updated dependencies [4f7eae9]
- Updated dependencies [242b322]
- Updated dependencies [d443474]
- Updated dependencies [a7ee5f7]
  - agex-ts@0.2.0
