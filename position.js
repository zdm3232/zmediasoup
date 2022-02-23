
let ZAV_POSITION_RIGHT = 0;
let ZAV_POSITION_BOTTOM = 1;
let ZAV_POSITION_LEFT = 2;
let ZAV_POSITION_TOP = 3;
let ZAV_STYLES = [ "right", "bottom", "left", "top" ];

export class position {
  static init() {
    game.settings.register( "zmediasoup", "position", {
      name: "Video Position",
      scope: "client",
      config: true,
      type: Number,
      default: 0,
      choices: {
	[ZAV_POSITION_RIGHT] : "Right",
	[ZAV_POSITION_BOTTOM] : "Bottom",
	[ZAV_POSITION_LEFT] : "Left",
	[ZAV_POSITION_TOP] : "Top"
      },
      onChange: () => {
	if ( ui.webrtc ) {
	  position.setStyle( ui.webrtc, ui.webrtc?.element );
	  ui.webrtc.render( true );
	}
      }
    });
  }

  static cameraViewHeightToWidth( height ) {
    // Calculate desired width based on height with banner and padding
    const width = (height - 32.5) * (4 / 3);
    return width;
  }

  static cameraViewMaxWidth( dockSize ) {
    let maxWidth = 320;
    switch (dockSize) {
    case "large":
      maxWidth = 320;
      break;
    case "medium":
      maxWidth = 240;
      break;
    case "small":
      maxWidth = 160;
      break;
    default:
      break;
    }
    return maxWidth;
  }

  static cameraViewsWidthFromWindowHeight( cameraCount, hidePlayerList ) {
    // Calculate desired width of the camera views based on the height of the window,
    //   number of users being displayed, and if the player list is visible
    const hotbarOffsetTop = ui.hotbar?.element.offset()?.top || 0;
    const navOffsetTop = ui.nav?.element.offset()?.top || 0;
    const navHeight = ui.nav?.element.height() || 0;
    let availableHeight = hotbarOffsetTop - (navOffsetTop + navHeight + 4);
    if ( !hidePlayerList ) {
      const playersHeight = ui.players?.element.height() || 0;
      const hotbarHeight = ui.hotbar?.element.height() || 0;
      availableHeight -= playersHeight - hotbarHeight + 4;
    }
    const heightPerCamera = availableHeight / cameraCount - 4;
    const desiredWidth = this.cameraViewHeightToWidth(heightPerCamera);
    return desiredWidth;
  }

  static async onCollapseSceneNavigation() {
    // Sleep for 300ms to give the bar time to collapse.
    await new Promise((r) => setTimeout(r, 300));
    if ( ui.webrtc ) {
      position.setStyle( ui.webrtc, ui.webrtc?.element );
    }
  }

  static onCollapseSidebar() {
    if ( ui.webrtc ) {
      position.setStyle( ui.webrtc, ui.webrtc?.element );
    }
  }

  static onRenderCameraViews( cameraviews, html ) {
    position.setStyle( cameraviews, html );
  }

  static setStyle( cameraviews, html ) {
    const pos = game.settings.get( "zmediasoup", "position");
    cameraviews.webrtc.settings.client.dockPosition = ZAV_STYLES[ pos ];
    switch( pos ) {
    case ZAV_POSITION_RIGHT:
      this.setTop( html );
      this.setWidth( cameraviews, html );
      this.setLeft( html);
      break;
    case ZAV_POSITION_BOTTOM:
      this.setBottom( html );
      break;
    case ZAV_POSITION_LEFT:
      this.setTop( html );
      this.setWidth( cameraviews, html );
      break;
    case ZAV_POSITION_TOP:
      this.setTop( html );
      break;
    }
  }

  static setLeft( html ) {
    let leftPosition = ui.sidebar?.element.offset()?.left;
    const htmlWidth = html.width();
    if ( leftPosition && htmlWidth ) leftPosition -= htmlWidth + 4;
    if ( leftPosition ) html.offset( { left: leftPosition } );
  }

  static setBottom( html ) {
    const uiBottom = document.getElementById("ui-bottom");
    if ( uiBottom ) {
      html.prependTo(uiBottom);
    }
  }

  static setTop( html ) {
    const uiTop = document.getElementById("ui-top");
    if ( uiTop ) {
      html.appendTo(uiTop);
    }
  }

  static setWidth( cameraviews, html ) {
    let hidePlayerList = true;
    if ( game.settings.get( "zmediasoup", "position") === ZAV_POSITION_LEFT ) {
      hidePlayerList = cameraviews.webrtc.settings.client.hidePlayerList;
    }

    // Determine the desired width
    const desiredWidth = position.cameraViewsWidthFromWindowHeight(
      html.children().length,
      hidePlayerList
    );

    // Set the width so that the height auto adjusts
    if ( desiredWidth <
	 this.cameraViewMaxWidth( cameraviews.webrtc?.settings.client.dockSize ) ) {
      html.width( desiredWidth );
    }
  }
}

Hooks.on( "setup", () => {
  Hooks.on( "renderCameraViews", position.onRenderCameraViews );
  Hooks.on( "collapseSidebar", position.onCollapseSidebar );
  Hooks.on( "sidebarCollapse", position.onCollapseSidebar );
  Hooks.on( "collapseSceneNavigation", position.onCollapseSceneNavigation );
});
