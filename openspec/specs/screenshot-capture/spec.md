# screenshot-capture Specification

## Purpose

Lets the user point at any region of the screen so it can be asked about, covering content that cannot be selected or copied — game UI, image-based PDFs, error dialogs, charts.

Two ideas carry most of the design. **Freeze first:** capture every monitor before showing anything, so the overlay cannot appear in its own capture and transient content like an open menu survives. **Trust the capture, not the webview:** all geometry is derived from the captured image's own dimensions, because a scale factor reported by the webview can disagree with the monitor's real one, and a factor that is even slightly wrong produces a crop that silently looks zoomed in.

## Requirements

### Requirement: Freeze-first capture

On the screenshot trigger the application SHALL capture every monitor FIRST, then display those captured images as the overlay background. The overlay MUST NOT be a transparent window over the live screen.

Capturing first avoids three problems: the overlay cannot appear in its own capture, there is no race between hiding a window and capturing, and transient content such as an open menu or tooltip is preserved in the frozen image.

#### Scenario: Overlay shows the frozen screen

- **WHEN** the screenshot hotkey fires
- **THEN** every monitor shows a dimmed overlay whose background is that monitor's captured image
- **AND** the content is the screen as it looked at trigger time, including any open menu

#### Scenario: Capture failure

- **WHEN** monitor enumeration or capture fails
- **THEN** the error is reported and no overlay is left on screen

### Requirement: One overlay window per monitor

The application SHALL create a separate overlay window per monitor rather than one window spanning the whole virtual desktop.

A single spanning window has one `devicePixelRatio`, which yields the wrong CSS-to-physical conversion on a mixed-DPI setup.

#### Scenario: Multi-monitor

- **WHEN** more than one monitor is present
- **THEN** each monitor gets its own overlay covering exactly that monitor's bounds
- **AND** the selection is cropped from the capture belonging to the monitor the user dragged on

### Requirement: Overlay sized in physical pixels

Each overlay SHALL be positioned and sized in physical pixels after the window is built, not via a logical size passed to the window builder.

A logical size is resolved against whichever scale factor the window was created on, which is not necessarily the target monitor's. The resulting mismatch skews the scale factor the crop is derived from.

#### Scenario: Overlay covers its monitor exactly

- **WHEN** an overlay is created for a monitor, including a non-primary monitor at a different scale factor
- **THEN** the overlay's bounds match that monitor's captured bounds

### Requirement: Preview delivered by pull

The overlay SHALL request its preview image from the backend when its canvas and listeners are ready. The backend MUST NOT push the preview on a timer after creating the window.

Tauri events are not buffered and WebView2 startup takes on the order of 100–300ms, so a timed emit is silently dropped and leaves the overlay blank. The stored preview must therefore be available before the window is created.

#### Scenario: Preview arrives regardless of webview startup time

- **WHEN** the overlay finishes initialising, however long that takes
- **THEN** it fetches and displays its monitor's preview

#### Scenario: Preview unavailable

- **WHEN** the overlay requests a preview and none is stored
- **THEN** the overlay cancels itself rather than remaining as a blank window blocking the screen

### Requirement: Region selection

The user SHALL select a region by dragging on the overlay. The unselected area stays dimmed and the selected area is drawn at full brightness with a visible border.

#### Scenario: Drag selects

- **WHEN** the user presses, drags, and releases the primary mouse button
- **THEN** the overlays close and the enclosed region is cropped

#### Scenario: Cutout tracks the drag accurately

- **WHEN** the bright cutout is drawn during a drag
- **THEN** its source region is scaled from canvas coordinates to image pixels, so the revealed content matches the region under the cursor

#### Scenario: Negligible drag ignored

- **WHEN** the drag is smaller than a few pixels in either dimension
- **THEN** no crop is produced

#### Scenario: Cancel

- **WHEN** the user presses Escape or right-clicks
- **THEN** all overlays close, no crop is produced, and the stored captures are released

### Requirement: Crop scale derived from the capture

The crop SHALL be computed by scaling the selection with a factor derived from the backend's own capture dimensions divided by the viewport size the overlay reports. The webview's `devicePixelRatio` MUST NOT be used for this.

`devicePixelRatio` can disagree with the monitor's real scale factor. A factor that is too small crops a smaller region, which is then upscaled for the API and appears zoomed in.

#### Scenario: Crop matches the drag on a scaled display

- **WHEN** the user selects a region on a display at a non-100% scale factor
- **THEN** the cropped image covers the same region that was dragged, at the capture's native resolution, with no zoom or offset

### Requirement: Images stay in RAM

Captured and cropped images SHALL NOT be written to disk at any point. They are held in memory and released when the chat popup closes, when selection is cancelled, or when a new capture replaces them.

#### Scenario: Released on chat close

- **WHEN** the chat popup closes
- **THEN** the stored captures are dropped

#### Scenario: Replaced by a new capture

- **WHEN** a new capture begins
- **THEN** the previous captures are replaced rather than accumulating
