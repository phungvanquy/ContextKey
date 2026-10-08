# vision-chat Specification

## Purpose

Sends a captured screen region to the model alongside a question, so the answer can be about what the user is looking at.

Two constraints shape it. **Consent is explicit:** an image is never transmitted until the user has seen its thumbnail and typed a question, so a screen capture cannot leave the machine by accident. **Context stays honest:** the session carries at most two images, and an evicted one is replaced in history by a visible placeholder rather than silently vanishing, so the model is never answering about a picture it can no longer see.

## Requirements

### Requirement: Nothing is sent without an explicit question

A captured image SHALL NOT be sent anywhere until the user types a question and submits it. The crop opens the chat popup with the image attached and the input empty.

#### Scenario: Crop opens chat without sending

- **WHEN** a region is selected
- **THEN** the chat popup opens showing a thumbnail of the crop and an empty input, and no API request has been made

#### Scenario: User controls what is sent

- **WHEN** the user reads the thumbnail before typing
- **THEN** it depicts exactly the image that will be transmitted

### Requirement: Multimodal request format

When a request carries one or more images, the message content SHALL be sent as an array of parts — the question as a text part, each image as an image-URL part holding a base64 data URL. Text-only history MUST continue to be sent as plain strings.

The message content type therefore accepts either a string or an array, so existing text-only conversation history deserializes unchanged.

#### Scenario: Question with image

- **WHEN** the user submits a question with an image attached
- **THEN** the request message contains the question text and the image data in one content array

#### Scenario: Text-only history unaffected

- **WHEN** a conversation has no images
- **THEN** its messages are sent as plain strings exactly as before

### Requirement: Image encoded for the vision API

A cropped image SHALL be downscaled so its longest edge is at most 1568 pixels and encoded as JPEG before transmission. The overlay's own preview is encoded separately at lower quality.

The 1568-pixel limit caps the image dimensions sent by the application. The overlay preview uses a separate encoding so its quality can be adjusted independently of the submitted image.

#### Scenario: Large crop downscaled

- **WHEN** a crop exceeds 1568px on its longest edge
- **THEN** it is downscaled proportionally before encoding

#### Scenario: Small crop untouched

- **WHEN** a crop is already within the limit
- **THEN** it is encoded without resampling

### Requirement: Vision model routing

When a request carries an image and a `vision_model` is configured, that model SHALL be used. When `vision_model` is empty, the main `model` is used.

#### Scenario: Vision model set

- **WHEN** history contains an image and `vision_model` is non-empty
- **THEN** the request targets `vision_model`

#### Scenario: Vision model blank

- **WHEN** history contains an image and `vision_model` is empty
- **THEN** the request targets the main `model`

#### Scenario: Text-only request

- **WHEN** history contains no image
- **THEN** the request targets the main `model` regardless of `vision_model`

### Requirement: Image delivered to a new popup by pull

When a crop opens a fresh chat popup, the popup SHALL fetch the pending image once its listeners are attached, and the fetch MUST consume it. When the popup was already open at capture time, the image MAY be pushed to it, since its listeners are known to be attached.

A timed push at a newly created window races webview startup and is dropped, because Tauri events are not buffered. Consuming the pending image on fetch prevents a leftover crop from re-attaching itself to an unrelated later chat session.

#### Scenario: Fresh popup receives the crop

- **WHEN** a crop opens a new chat popup, however slowly the webview initialises
- **THEN** the popup attaches the crop

#### Scenario: No stale crop resurfaces

- **WHEN** a crop is taken, the chat popup is closed without sending, and a later chat session begins
- **THEN** the earlier crop is not attached to it

#### Scenario: Already-open popup receives a second crop

- **WHEN** a capture completes while the chat popup is open
- **THEN** the crop attaches to the existing session

### Requirement: Two-image cap with explicit eviction

A session SHALL carry at most two images. When a third arrives, the oldest is evicted and every reference to it already in the conversation history is replaced with a placeholder noting that an earlier screenshot was removed.

Silently dropping an image would leave the model answering about a picture it can no longer see, with no indication that the context changed.

#### Scenario: Second image attaches

- **WHEN** a second capture arrives in one session
- **THEN** both thumbnails are shown and both images are sent with the next question

#### Scenario: Third image evicts the oldest

- **WHEN** a third capture arrives
- **THEN** the oldest image is removed from the strip and its history entries become the removal placeholder
