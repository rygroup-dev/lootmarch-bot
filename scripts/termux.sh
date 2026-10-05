#!/data/data/com.termux/files/usr/bin/bash
# LootMarch bot on Android (Termux): start | stop | restart | status | log
# Keeps the phone awake while the bot runs and restarts it 10 s after a crash.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$DIR/bot.log"
LOOP_PID="$DIR/data/loop.pid"

running() { [ -f "$LOOP_PID" ] && kill -0 "$(cat "$LOOP_PID")" 2>/dev/null; }

case "${1:-start}" in
  start)
    if running; then echo "Bot sudah jalan (loop PID $(cat "$LOOP_PID"))."; exit 0; fi
    mkdir -p "$DIR/data"
    command -v termux-wake-lock >/dev/null && termux-wake-lock
    (
      cd "$DIR" || exit 1
      while true; do
        node src/index.js >> "$LOG" 2>&1
        [ $? -eq 3 ] && break   # another copy is already running
        sleep 10
      done
    ) </dev/null >/dev/null 2>&1 &
    echo $! > "$LOOP_PID"
    echo "Bot jalan di latar belakang. Log: $LOG"
    ;;
  stop)
    if running; then kill "$(cat "$LOOP_PID")" 2>/dev/null; fi
    rm -f "$LOOP_PID"
    [ -f "$DIR/data/bot.pid" ] && kill "$(cat "$DIR/data/bot.pid")" 2>/dev/null
    command -v termux-wake-unlock >/dev/null && termux-wake-unlock
    echo "Bot dihentikan."
    ;;
  restart) "$0" stop; sleep 2; "$0" start ;;
  status) if running; then echo "Jalan (loop PID $(cat "$LOOP_PID"))"; else echo "Berhenti"; fi ;;
  log) tail -n 50 -f "$LOG" ;;
  *) echo "Pakai: $0 start|stop|restart|status|log"; exit 1 ;;
esac
