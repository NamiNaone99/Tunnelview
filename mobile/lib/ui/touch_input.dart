/// Turns touches on the remote picture into mouse input for the computer.
///
/// - tap: left click (two quick taps: a double click);
/// - touch and hold: right click;
/// - one-finger drag: drag with the left button held;
/// - two-finger drag: scroll (or move the picture while it is zoomed);
/// - pinch: zoom the picture on the phone.
library;

import 'dart:async';
import 'dart:ui';

import 'remote_geometry.dart';

/// Movement (logical pixels) below which a touch is still a tap.
const double touchSlop = 12;
const Duration longPress = Duration(milliseconds: 500);
const Duration doubleTapWindow = Duration(milliseconds: 350);
const double doubleTapDistance = 40;

/// Wheel pixels sent per logical pixel of two-finger movement.
const double scrollFactor = 3;

/// Largest wheel delta the host accepts in one message.
const double wheelMax = 10000;

enum _Mode { idle, pending, drag, held, two, zoom, scroll, done }

/// One gesture recogniser for the remote view. Feed it pointer events; it
/// calls [send] with `input` messages and [onView] with zoom changes.
class TouchInput {
  TouchInput({
    required this.send,
    required this.onView,
    this.onLongPress,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// Sends one `input` message; false when it could not be sent.
  final bool Function(Map<String, Object?> msg) send;

  /// The user changed the zoom or pan.
  final void Function(ViewTransform view) onView;

  /// A touch-and-hold became a right click (for haptic feedback).
  final void Function()? onLongPress;

  final DateTime Function() _now;

  /// Set by the view on every layout.
  Rect fit = Rect.zero;
  Size viewport = Size.zero;
  ViewTransform view = ViewTransform.identity;

  final Map<int, Offset> _pointers = {};
  _Mode _mode = _Mode.idle;
  Offset _start = Offset.zero;
  Timer? _holdTimer;
  DateTime? _lastTapAt;
  Offset _lastTapPos = Offset.zero;
  int _clicks = 0;
  bool _buttonDown = false;
  Offset _twoCentroid = Offset.zero;
  double _twoDistance = 0;
  Offset _twoStartCentroid = Offset.zero;
  double _twoStartDistance = 0;

  Offset? _remote(Offset local) => toRemote(local, fit, view);

  void down(int pointer, Offset position) {
    _pointers[pointer] = position;
    if (_pointers.length == 1) {
      _mode = _Mode.pending;
      _start = position;
      _holdTimer?.cancel();
      _holdTimer = Timer(longPress, _onHold);
    } else if (_pointers.length == 2) {
      _holdTimer?.cancel();
      _releaseButton(position);
      _mode = _Mode.two;
      _twoStartCentroid = _twoCentroid = _centroid();
      _twoStartDistance = _twoDistance = _distance();
    } else {
      _mode = _Mode.done;
    }
  }

  void move(int pointer, Offset position) {
    if (!_pointers.containsKey(pointer)) return;
    _pointers[pointer] = position;
    switch (_mode) {
      case _Mode.pending:
        if ((position - _start).distance <= touchSlop) return;
        _holdTimer?.cancel();
        final p = _remote(_start);
        if (p == null) {
          _mode = _Mode.done;
          return;
        }
        _mode = _Mode.drag;
        _buttonDown = send(_button('md', 0, p, 1));
        _moveTo(position);
      case _Mode.drag:
        _moveTo(position);
      case _Mode.two:
        final c = _centroid();
        final d = _distance();
        if (_twoStartDistance > 0 && (d / _twoStartDistance - 1).abs() > 0.12) {
          _mode = _Mode.zoom;
        } else if ((c - _twoStartCentroid).distance > touchSlop) {
          _mode = view.isZoomed ? _Mode.zoom : _Mode.scroll;
        } else {
          return;
        }
        _twoCentroid = c;
        _twoDistance = d;
      case _Mode.zoom:
        final c = _centroid();
        final d = _distance();
        final factor = _twoDistance > 0 ? d / _twoDistance : 1.0;
        view = view.zoomedAt(c, factor, c - _twoCentroid, viewport);
        _twoCentroid = c;
        _twoDistance = d;
        onView(view);
      case _Mode.scroll:
        final c = _centroid();
        final delta = c - _twoCentroid;
        _twoCentroid = c;
        // Fingers up moves the content up: the wheel scrolls down.
        final dx = (-delta.dx * scrollFactor).clamp(-wheelMax, wheelMax);
        final dy = (-delta.dy * scrollFactor).clamp(-wheelMax, wheelMax);
        if (dx != 0 || dy != 0) send({'t': 'wh', 'dx': dx, 'dy': dy});
      case _Mode.idle:
      case _Mode.held:
      case _Mode.done:
        return;
    }
  }

  void up(int pointer, Offset position) {
    if (_pointers.remove(pointer) == null) return;
    switch (_mode) {
      case _Mode.pending:
        _holdTimer?.cancel();
        _tap(_start);
      case _Mode.drag:
        _releaseButton(position);
      case _Mode.idle:
      case _Mode.held:
      case _Mode.two:
      case _Mode.zoom:
      case _Mode.scroll:
      case _Mode.done:
        break;
    }
    _mode = _pointers.isEmpty ? _Mode.idle : _Mode.done;
  }

  /// The system took the gesture away.
  void cancel(int pointer) {
    final last = _pointers.remove(pointer);
    _holdTimer?.cancel();
    if (last != null) _releaseButton(last);
    _mode = _pointers.isEmpty ? _Mode.idle : _Mode.done;
  }

  /// Forgets every touch; a held button is released.
  void reset() {
    _holdTimer?.cancel();
    if (_buttonDown) {
      _buttonDown = false;
      send({'t': 'release-all'});
    }
    _pointers.clear();
    _mode = _Mode.idle;
  }

  void dispose() => _holdTimer?.cancel();

  void _onHold() {
    if (_mode != _Mode.pending) return;
    _mode = _Mode.held;
    final p = _remote(_start);
    if (p == null) return;
    if (send(_button('md', 2, p, 1))) {
      send(_button('mu', 2, p, 1));
      onLongPress?.call();
    }
  }

  void _tap(Offset position) {
    final p = _remote(position);
    if (p == null) return;
    final at = _now();
    final last = _lastTapAt;
    final again =
        last != null &&
        at.difference(last) <= doubleTapWindow &&
        (position - _lastTapPos).distance <= doubleTapDistance;
    _clicks = again && _clicks < 3 ? _clicks + 1 : 1;
    _lastTapAt = at;
    _lastTapPos = position;
    if (send(_button('md', 0, p, _clicks))) {
      send(_button('mu', 0, p, _clicks));
    }
  }

  void _moveTo(Offset position) {
    final p = _remote(position);
    if (p != null) send({'t': 'mm', 'x': p.dx, 'y': p.dy});
  }

  void _releaseButton(Offset position) {
    if (!_buttonDown) return;
    _buttonDown = false;
    final p = _remote(position);
    if (p == null || !send(_button('mu', 0, p, 1))) {
      send({'t': 'release-all'});
    }
  }

  Map<String, Object?> _button(String t, int b, Offset p, int n) => {
    't': t,
    'b': b,
    'x': p.dx,
    'y': p.dy,
    'n': n,
  };

  Offset _centroid() {
    var sum = Offset.zero;
    for (final p in _pointers.values) {
      sum += p;
    }
    return sum / _pointers.length.toDouble();
  }

  double _distance() {
    final p = _pointers.values.toList();
    return p.length < 2 ? 0 : (p[0] - p[1]).distance;
  }
}
