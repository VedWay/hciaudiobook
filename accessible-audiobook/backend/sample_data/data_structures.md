title: Data Structures
author: Open Course Sample Text
description: A short introductory unit on stacks and queues. Written for this project as freely usable demonstration content.

# Chapter 1: Stacks

A data structure is a way of organising data so that it can be used efficiently. Different data structures suit different tasks. This chapter introduces the stack, one of the simplest and most useful of them.

## What Is a Stack?

A stack is a collection of items in which items are added and removed at the same end. That end is called the top of the stack. The last item placed on a stack is the first item taken off. This rule is known as last in, first out, usually written LIFO.

A pile of plates is a good everyday picture of a stack. You put a clean plate on the top of the pile, and when you need a plate you take the one on the top. You never pull a plate out from the middle.

## Stack Operations

A stack has two main operations. The push operation adds an item to the top of the stack. The pop operation removes the item at the top of the stack and returns it. A third operation, called peek, returns the top item without removing it.

Trying to pop from an empty stack is an error called stack underflow. Trying to push onto a stack that has no room left is an error called stack overflow. All three operations take the same small amount of time no matter how many items the stack holds, so we say they run in constant time.

## Uses of Stacks

Stacks appear throughout computing. When a function calls another function, the computer saves the place to return to on a stack named the call stack. When the called function finishes, that place is popped and execution continues from it. The undo feature of a text editor is also a stack. Each change is pushed, and choosing undo pops the most recent change. Stacks are also used to check that brackets in a program are balanced, and to evaluate arithmetic expressions.

# Chapter 2: Queues

A queue is closely related to a stack, but it removes items in the opposite order.

## What Is a Queue?

A queue is a collection of items in which items are added at one end and removed from the other end. The end where items are added is called the rear. The end where items are removed is called the front. The first item placed in a queue is the first item taken out. This rule is known as first in, first out, usually written FIFO.

A line of people waiting at a ticket counter is a queue. A new person joins at the rear of the line, and the person at the front is served next.

## Queue Operations

The enqueue operation adds an item to the rear of the queue. The dequeue operation removes the item at the front of the queue and returns it. Like the stack operations, both run in constant time when the queue is built carefully.

A queue stored in an array is often arranged as a circular queue. In a circular queue, the position after the last array slot is the first array slot, so the space freed by removed items can be used again.

## Uses of Queues

Queues are used whenever things must be handled in the order they arrive. An operating system keeps the processes that are ready to run in a queue. A printer keeps its waiting documents in a queue. Network routers hold packets in queues before forwarding them. A special kind of queue, called a priority queue, removes the most important item first instead of the oldest one.
