// elyxion-loop implementation — see elyxion-loop.h for the design notes.
//
// Deliberately small: the CLI's needs (fs readiness, socket traffic, timers,
// deferred work) are a fraction of libuv's surface. Everything here is plain
// POSIX + Linux epoll; no third-party code.

#include "elyxion-loop.h"

#include <sys/epoll.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>

namespace elyxion {

Loop::Loop() {
  epoll_fd_ = epoll_create1(0);
}

Loop::~Loop() {
  if (epoll_fd_ >= 0) close(epoll_fd_);
}

uint64_t Loop::nowMs() const {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

void Loop::onReadable(int fd, FdCallback cb) {
  FdEntry &e = fds_[fd];
  e.want_read = true;
  e.read_cb = std::move(cb);
  updateInterest(fd);
}

void Loop::onWritable(int fd, FdCallback cb) {
  FdEntry &e = fds_[fd];
  e.want_write = true;
  e.write_cb = std::move(cb);
  updateInterest(fd);
}

void Loop::clearFd(int fd) {
  fds_.erase(fd);
  epoll_ctl(epoll_fd_, EPOLL_CTL_DEL, fd, nullptr);
}

void Loop::updateInterest(int fd) {
  const FdEntry &e = fds_[fd];
  epoll_event ev{};
  ev.events = 0;
  if (e.want_read) ev.events |= EPOLLIN;
  if (e.want_write) ev.events |= EPOLLOUT;
  ev.data.fd = fd;
  if (ev.events == 0) {
    clearFd(fd);
    return;
  }
  // Try modify first; add if it isn't registered yet.
  if (epoll_ctl(epoll_fd_, EPOLL_CTL_MOD, fd, &ev) != 0 && errno == ENOENT) {
    epoll_ctl(epoll_fd_, EPOLL_CTL_ADD, fd, &ev);
  }
}

uint64_t Loop::setTimeout(uint64_t delay_ms, TimerCallback cb) {
  const uint64_t id = next_timer_id_++;
  timers_.push({nowMs() + delay_ms, 0, id, std::move(cb)});
  return id;
}

uint64_t Loop::setInterval(uint64_t interval_ms, TimerCallback cb) {
  const uint64_t id = next_timer_id_++;
  timers_.push({nowMs() + interval_ms, interval_ms, id, std::move(cb)});
  return id;
}

void Loop::clearTimer(uint64_t id) {
  cancelled_timers_.push_back(id);
}

void Loop::setImmediate(TimerCallback cb) {
  immediates_.emplace_back(0, std::move(cb));
}

bool Loop::alive() const {
  return !fds_.empty() || !timers_.empty();
}

void Loop::stop() {
  running_ = false;
}

void Loop::drainImmediates() {
  // Swap so callbacks that enqueue more immediates run next iteration
  // (prevents a self-rescheduling immediate from starving I/O forever).
  std::vector<std::pair<uint64_t, TimerCallback>> work;
  work.swap(immediates_);
  for (auto &[id, cb] : work) cb();
}

void Loop::run() {
  running_ = true;
  std::vector<epoll_event> events(64);

  while (running_) {
    drainImmediates();

    // Fire due timers. Due timers fire even on the iteration where stop()
    // was called, so a stop() from an earlier callback doesn't swallow them.
    const uint64_t now = nowMs();
    while (!timers_.empty() && timers_.top().when_ms <= now) {
      Timer t = timers_.top();
      timers_.pop();
      if (std::find(cancelled_timers_.begin(), cancelled_timers_.end(), t.id) != cancelled_timers_.end()) {
        continue;
      }
      if (t.interval > 0) {
        // Re-arm before running so the callback can clear itself.
        t.when_ms = now + t.interval;
        timers_.push(t);
      }
      t.cb();
    }
    // Compact the cancel list occasionally (it only grows on clears).
    if (cancelled_timers_.size() > 256) cancelled_timers_.clear();

    // Compute sleep: next timer deadline, bounded so immediates enqueue-able
    // by other threads still get a chance (1 s ceiling; the CLI is
    // single-threaded so this is mostly belt-and-braces).
    int timeout_ms = 1000;
    if (!timers_.empty()) {
      const int64_t until = static_cast<int64_t>(timers_.top().when_ms) - static_cast<int64_t>(nowMs());
      timeout_ms = static_cast<int>(std::clamp<int64_t>(until, 0, 1000));
    }

    const int n = epoll_wait(epoll_fd_, events.data(), static_cast<int>(events.size()), timeout_ms);
    for (int i = 0; i < n; i++) {
      const int fd = events[i].data.fd;
      auto it = fds_.find(fd);
      if (it == fds_.end()) continue;
      const FdEntry e = it->second; // copy: callback may clear the fd
      if ((events[i].events & EPOLLIN) && e.read_cb) e.read_cb();
      if ((events[i].events & EPOLLOUT) && e.write_cb) e.write_cb();
    }

    // Nothing left to wait on — the loop is done (matches libuv's default
    // mode: run until the handle/ref count drops to zero).
    if (!running_ || (!alive() && immediates_.empty())) break;
  }
}

} // namespace elyxion
