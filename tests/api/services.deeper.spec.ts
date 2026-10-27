import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { TaskStatus, WorkspaceRole } from "@workspace/shared";
import { ChannelsService } from "../../apps/api/src/channels/channels.service";
import { MessagesService } from "../../apps/api/src/messages/messages.service";
import { TasksService } from "../../apps/api/src/tasks/tasks.service";

describe("API services deeper behavior", () => {
  describe("ChannelsService", () => {
    it("builds a parent/child tree and excludes archived channels", async () => {
      const prisma = {
        workspaceMember: { findUnique: jest.fn().mockResolvedValue({ userId: "u1" }) },
        channel: {
          findMany: jest.fn().mockResolvedValue([
            { id: "root", workspaceId: "w1", name: "general", parentId: null },
            { id: "child", workspaceId: "w1", name: "thread", parentId: "root" },
            { id: "archived", workspaceId: "w1", name: "[archived] old", parentId: null },
            { id: "orphan", workspaceId: "w1", name: "orphan", parentId: "missing" },
          ]),
        },
      };

      const result = await new ChannelsService(prisma as any).channels("u1", "w1");
      expect(result.map((channel) => channel.id)).toEqual(["root", "orphan"]);
      expect(result[0].children.map((channel: { id: string }) => channel.id)).toEqual(["child"]);
      expect(result.some((channel) => channel.id === "archived")).toBe(false);
    });

    it("rejects a parent from a different workspace before creating", async () => {
      const prisma = {
        workspaceMember: { findUnique: jest.fn().mockResolvedValue({ userId: "u1" }) },
        channel: { findUnique: jest.fn().mockResolvedValue({ id: "parent", workspaceId: "other" }), create: jest.fn() },
      };

      await expect(
        new ChannelsService(prisma as any).createChannel("u1", "w1", "child", false, "parent"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.channel.create).not.toHaveBeenCalled();
    });

    it("archives idempotently and decorates the public name", async () => {
      const prisma = {
        channel: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({ id: "c1", workspaceId: "w1", name: "general" })
            .mockResolvedValueOnce({ id: "c1", workspaceId: "w1", name: "[archived] general" }),
          update: jest.fn().mockResolvedValue({ id: "c1", workspaceId: "w1", name: "[archived] general" }),
        },
        workspaceMember: { findUnique: jest.fn().mockResolvedValue({ userId: "u1" }) },
      };
      const service = new ChannelsService(prisma as any);

      await expect(service.archiveChannel("u1", "c1")).resolves.toMatchObject({ name: "general", isArchived: true });
      await expect(service.archiveChannel("u1", "c1")).resolves.toMatchObject({ name: "general", isArchived: true });
      expect(prisma.channel.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("TasksService", () => {
    it("requires the assignee to be a workspace member", async () => {
      const prisma = {
        task: { findUnique: jest.fn().mockResolvedValue({ id: "t1", workspaceId: "w1" }), update: jest.fn() },
        workspaceMember: {
          findUnique: jest.fn().mockResolvedValueOnce({ userId: "owner" }).mockResolvedValueOnce(null),
        },
      };

      await expect(new TasksService(prisma as any).assignTask("owner", "t1", "outsider")).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it("updates status only after task ownership scope is verified", async () => {
      const prisma = {
        task: {
          findUnique: jest.fn().mockResolvedValue({ id: "t1", workspaceId: "w1" }),
          update: jest.fn().mockResolvedValue({ id: "t1", status: TaskStatus.DONE }),
        },
        workspaceMember: { findUnique: jest.fn().mockResolvedValue({ userId: "owner" }) },
      };

      await expect(new TasksService(prisma as any).updateTaskStatus("owner", "t1", TaskStatus.DONE)).resolves.toEqual({
        id: "t1",
        status: TaskStatus.DONE,
      });
      expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: TaskStatus.DONE } });
    });
  });

  describe("MessagesService", () => {
    it("returns chronological pages and a cursor when there are more rows", async () => {
      const rows = [
        { id: "newest", channelId: "c1", authorId: "u1", createdAt: new Date("2026-01-03"), body: "new" },
        { id: "middle", channelId: "c1", authorId: "u1", createdAt: new Date("2026-01-02"), body: "middle" },
        { id: "oldest", channelId: "c1", authorId: "u1", createdAt: new Date("2026-01-01"), body: "old" },
      ];
      const prisma = {
        channel: { findUnique: jest.fn().mockResolvedValue({ id: "c1", workspaceId: "w1" }) },
        workspaceMember: { findUnique: jest.fn().mockResolvedValue({ userId: "u1" }) },
        message: {
          findMany: jest.fn().mockResolvedValue(rows),
          count: jest.fn().mockResolvedValue(0),
        },
      };
      const pubSub = { publish: jest.fn() };

      const result = await new MessagesService(prisma as any, pubSub as any).messages("u1", "c1", undefined, 2);
      expect(result.items.map((message) => message.id)).toEqual(["middle", "newest"]);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe("middle");
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3, orderBy: { createdAt: "desc" } }),
      );
    });

    it("rejects editing another user's message and does not write", async () => {
      const prisma = {
        message: { findUnique: jest.fn().mockResolvedValue({ id: "m1", authorId: "owner", deletedAt: null }), update: jest.fn() },
      };
      const service = new MessagesService(prisma as any, {} as any);

      await expect(service.editMessage("other", "m1", "tampered")).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.message.update).not.toHaveBeenCalled();
    });

    it("treats repeated deletion as a harmless false result", async () => {
      const prisma = {
        message: { findUnique: jest.fn().mockResolvedValue({ id: "m1", authorId: "owner", deletedAt: new Date() }), update: jest.fn() },
      };
      const service = new MessagesService(prisma as any, {} as any);

      await expect(service.deleteMessage("owner", "m1")).resolves.toBe(false);
      expect(prisma.message.update).not.toHaveBeenCalled();
    });
  });
});
