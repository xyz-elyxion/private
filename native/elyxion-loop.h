// elyxion-loop: Elyxion's own event loop (no libuv, no Node).
//
// A minimal epoll-backed loop for the embedded Elyxion runtime. When the CLI
// runs on its own V8 embedder (see native/elyxion-shell.cc), THIS is what
// drives everything instead of Node's libuv loop:
//
//   • timer heap       — setTimeout / setInterval (binary min-heap)
//   • fd readiness     — epoll(7) level-triggered interest list
//   • immediate queue  — setImmediate work drained before blocking
//   • idle sleep       — epoll_wait until the next timer deadline
//
// Linux-only for now (epoll); kqueue/IOCP backends slot in behind the same
// interface later.

#pragma once

#include <cstdint>
#include <cstddef>
#include <functional>
#include <map>
#include <queue>
#include <vector>

namespace elyxion {

class Loop {
public:
  using FdCallback = std::function<void()>;
  using TimerCallback = std::function<void()>;

  Loop();
  ~Loop();

  // Non-copyable — owns the epoll fd.
  Loop(const Loop &) = delete;
  Loop &operator=(const Loop &) = delete;

  // Register interest in readability/writability on an fd. One callback per
  // (fd, events) pair; calling again for the same fd+events replaces it.
  void onReadable(int fd, FdCallback cb);
  void onWritable(int fd, FdCallback cb);
  void clearFd(int fd);

  // Timers. `delay_ms` from now; interval 0 = one-shot. Returns an id usable
  // with clearTimer.
  uint64_t setTimeout(uint64_t delay_ms, TimerCallback cb);
  uint64_t setInterval(uint64_t interval_ms, TimerCallback cb);
  void clearTimer(uint64_t id);

  // Deferred work: drained each iteration before the loop blocks.
  void setImmediate(TimerCallback cb);

  // Run until no handles remain (like libuv's default mode) or until stop().
  void run();
  void stop();

  bool alive() const;

private:
  struct Timer {
    uint64_t when_ms;   // absolute monotonic deadline
    uint64_t interval;  // 0 = one-shot
    uint64_t id;
    TimerCallback cb;
    // Min-heap ordering by deadline.
    bool operator>(const Timer &o) const { return when_ms > o.when_ms; }
  };

  struct FdEntry {
    bool want_read = false;
    bool want_write = false;
    FdCallback read_cb;
    FdCallback write_cb;
  };

  uint64_t nowMs() const;
  void updateInterest(int fd);
  void drainImmediates();

  int epoll_fd_ = -1;
  bool running_ = false;
  uint64_t next_timer_id_ = 1;

  std::map<int, FdEntry> fds_;
  // Greater<> gives a min-heap on Timer::when_ms.
  std::priority_queue<Timer, std::vector<Timer>, std::greater<Timer>> timers_;
  std::vector<std::pair<uint64_t, TimerCallback>> immediates_;
  std::vector<uint64_t> cancelled_timers_;
};

} // namespace elyxion
