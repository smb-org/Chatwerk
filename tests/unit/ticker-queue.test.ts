import { describe, expect, it } from "vitest";
import { BoundedTickerQueue } from "../../src/renderer/ticker-queue";

describe("bounded ticker queue", () => {
  it("drops the oldest waiting item when full", () => {
    const queue = new BoundedTickerQueue<number>(3);
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(queue.enqueue(4)).toBe(1);
    expect(queue.toArray()).toEqual([2, 3, 4]);
    expect(queue.dequeue()).toBe(2);
  });

  it("removes moderated items while they are still queued", () => {
    const queue = new BoundedTickerQueue<{ room: string; id: number }>(5);
    queue.enqueue({ room: "a", id: 1 });
    queue.enqueue({ room: "b", id: 2 });
    queue.enqueue({ room: "a", id: 3 });
    expect(queue.remove((item) => item.room === "a")).toBe(2);
    expect(queue.toArray()).toEqual([{ room: "b", id: 2 }]);
  });
});
