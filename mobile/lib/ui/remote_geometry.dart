/// Where the remote picture sits on the phone's screen, and which point of
/// the remote display a touch means.
library;

import 'dart:ui';

/// The largest zoom.
const double maxZoom = 6;

/// The rectangle [video] occupies when fitted inside [viewport], aspect
/// ratio kept and centred. [Rect.zero] while either size is empty.
Rect fitRect(Size viewport, Size video) {
  if (viewport.isEmpty || video.isEmpty) return Rect.zero;
  final scale =
      (viewport.width / video.width) < (viewport.height / video.height)
      ? viewport.width / video.width
      : viewport.height / video.height;
  final w = video.width * scale;
  final h = video.height * scale;
  // The side that fills the viewport can come out a hair wider: no negative
  // (or negative zero) margin.
  final left = (viewport.width - w) / 2;
  final top = (viewport.height - h) / 2;
  return Rect.fromLTWH(left > 0 ? left : 0, top > 0 ? top : 0, w, h);
}

/// The user's zoom and pan of the fitted picture: a screen point is
/// `fitted * scale + offset`.
class ViewTransform {
  const ViewTransform({this.scale = 1, this.offset = Offset.zero});

  static const ViewTransform identity = ViewTransform();

  final double scale;
  final Offset offset;

  bool get isZoomed => scale > 1.01;

  /// The same transform kept inside its limits: zoom 1..[maxZoom], and the
  /// picture never leaves [viewport] further than needed.
  ViewTransform clamped(Size viewport) {
    final s = scale.clamp(1.0, maxZoom);
    final minX = viewport.width * (1 - s);
    final minY = viewport.height * (1 - s);
    return ViewTransform(
      scale: s,
      offset: Offset(offset.dx.clamp(minX, 0.0), offset.dy.clamp(minY, 0.0)),
    );
  }

  /// Zooms by [factor] keeping the screen point [focal] fixed, then moves by
  /// [pan].
  ViewTransform zoomedAt(
    Offset focal,
    double factor,
    Offset pan,
    Size viewport,
  ) {
    final s = (scale * factor).clamp(1.0, maxZoom);
    final applied = s / scale;
    return ViewTransform(
      scale: s,
      offset: focal - (focal - offset) * applied + pan,
    ).clamped(viewport);
  }
}

/// The point of the remote display under the screen point [local], as x and
/// y in [0, 1]. Points outside the picture are clamped to its edge. Null
/// while there is no picture.
Offset? toRemote(Offset local, Rect fit, ViewTransform view) {
  if (fit.isEmpty) return null;
  final fitted = (local - view.offset) / view.scale;
  final x = ((fitted.dx - fit.left) / fit.width).clamp(0.0, 1.0);
  final y = ((fitted.dy - fit.top) / fit.height).clamp(0.0, 1.0);
  return Offset(x, y);
}
