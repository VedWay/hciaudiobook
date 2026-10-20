title: Operating Systems
author: Open Course Sample Text
description: An introductory textbook unit on memory management, paging and virtual memory. Written for this project as freely usable demonstration content.

# Chapter 1: Memory Management Basics

A program can only run when it has been loaded into main memory. Main memory, also called RAM, is a large array of bytes, and every byte has its own address. The processor fetches instructions from memory, and those instructions read and write data that is also held in memory. Because memory is limited and many programs want to use it at the same time, the operating system must decide who gets which part of it. This job is called memory management.

## Why Memory Must Be Managed

A modern computer runs dozens of processes at once. A process is a program in execution, together with the data it is working on. If every process could write anywhere in memory, a single faulty program could overwrite another program, or even the operating system itself. Memory management therefore has three goals. The first goal is protection, which means that one process cannot read or change the memory of another. The second goal is efficiency, which means that as little memory as possible is wasted. The third goal is convenience, which means that a programmer should not need to know where in memory the program will finally be placed.

The part of the operating system that carries out this work is called the memory manager. It keeps track of which parts of memory are in use and which parts are free. It gives memory to a process when the process needs it, and it takes the memory back when the process finishes.

## Logical and Physical Addresses

An address that a program uses while it runs is called a logical address. An address that refers to a real location in the memory chips is called a physical address. The two are not the same. A program is written as if it starts at address zero, but it may be loaded anywhere in physical memory.

The translation from a logical address to a physical address is done by a hardware device called the memory management unit, or MMU. In the simplest scheme, the MMU holds a value called the base register. Every logical address produced by the program is added to the base register to give the physical address. A second value, called the limit register, holds the size of the program. If a logical address is larger than the limit, the hardware raises an error and the operating system stops the process. This is how one process is prevented from touching the memory of another.

The complete set of logical addresses that a process can use is called its logical address space. Because these addresses are not real locations, a logical address is also called a virtual address.

## Contiguous Allocation and Fragmentation

The oldest way to share memory is contiguous allocation. Each process is given one single, unbroken block of physical memory. When a process ends, its block becomes a hole of free memory. Over time, memory fills with many holes of different sizes scattered between the running processes.

This leads to a problem called external fragmentation. External fragmentation happens when there is enough free memory in total to load a new process, but the free memory is split into small holes and no single hole is large enough. For example, suppose three holes of 10 megabytes each are free. A process that needs 25 megabytes cannot be loaded, even though 30 megabytes are free.

One cure is compaction, which means moving all the processes together so that the free memory forms one large block. Compaction works, but it is slow, because the operating system must copy a great deal of memory while no useful work is done. A better solution is to stop requiring that a process occupy one unbroken block. That idea is called paging, and it is the subject of the next chapter.

# Chapter 2: Paging

Paging is a memory management scheme that removes the need for contiguous allocation. With paging, the physical memory used by a process can be scattered anywhere, and the process never notices. Paging is used by almost every operating system today.

## Pages and Frames

In paging, physical memory is divided into fixed-size blocks called frames. Logical memory is divided into blocks of the same size called pages. A common page size is 4 kilobytes. When a process is loaded, each of its pages is placed into any frame that happens to be free. The frames do not need to be next to each other.

Because every frame has the same size, any free frame can hold any page. This means that paging has no external fragmentation at all. However, paging does suffer from a smaller problem called internal fragmentation. Internal fragmentation is wasted space inside an allocated block. For example, if the page size is 4 kilobytes and a process needs 9 kilobytes, it is given three pages, which is 12 kilobytes. The last 3 kilobytes are allocated to the process but never used.

## The Page Table

The operating system must remember which frame holds each page. It does this with a data structure called a page table. Every process has its own page table. A page table maps virtual addresses to physical addresses.

A logical address is split into two parts, a page number and an offset. The page number is used as an index into the page table. The entry found there gives the frame number. The frame number is then combined with the offset to produce the physical address. The offset is not changed, because a page and a frame have the same size.

Consider a small example. Suppose the page size is 4 kilobytes and the page table says that page 2 is stored in frame 7. A program that reads the tenth byte of page 2 is really reading the tenth byte of frame 7. The program only ever sees page numbers. It has no idea which frames it is using.

Each page table entry also holds a few control bits. The most important is the valid bit. The valid bit says whether the page is currently in memory. If a process tries to use a page whose valid bit is off, the hardware stops the instruction and hands control to the operating system. Other bits record whether the page may be written, and whether it has been changed since it was loaded. The bit that records a change is called the dirty bit.

## The Translation Lookaside Buffer

Paging has a cost. Every memory access now needs two memory accesses, one to read the page table and one to read the data itself. This would make programs run at half speed.

The solution is a small, very fast hardware cache called the translation lookaside buffer, or TLB. The TLB stores the most recently used page table entries. When the processor needs to translate a page number, it first looks in the TLB. If the entry is there, the event is called a TLB hit, and the frame number is available almost immediately. If the entry is not there, the event is called a TLB miss. On a TLB miss, the page table in memory is consulted, and the result is copied into the TLB for next time.

The TLB works well because of a property called locality of reference. Locality of reference means that a program tends to use the same small group of pages again and again over a short period of time. Because of locality, a TLB with only a few hundred entries can answer more than ninety nine percent of all translations.

# Chapter 3: Virtual Memory

So far we have assumed that an entire process must be in main memory before it can run. Virtual memory removes this restriction. It is one of the most important ideas in operating systems.

## What Is Virtual Memory?

Virtual memory allows a process to use more memory than is physically available in the main memory. It does this by keeping only the parts of a program that are currently needed in RAM, and leaving the rest on a storage device such as a hard disk or a solid state drive. The area of storage used for this purpose is called the swap space, or the backing store.

Virtual memory is necessary for three reasons. First, programs are often larger than the physical memory of the computer, and without virtual memory they could not run at all. Second, most programs do not need all of their code and data at the same time. Code that handles rare error conditions, for example, may never be executed. Loading it would waste memory. Third, when each process uses less physical memory, more processes can be kept in memory at once, so the processor is kept busy and the system gets more work done.

Virtual memory also makes life easier for the programmer. Each process is given a large virtual address space of its own, and the programmer can write the program as if the whole space were available. The operating system and the hardware quietly arrange for the right pages to be in memory at the right time.

The idea is not new. Virtual memory was first built for the Atlas computer at the University of Manchester, which began running in 1962. The designers called it a one-level store, because it made the fast main memory and the slow drum storage look like one single large memory.

## Demand Paging

The most common way to implement virtual memory is demand paging. In demand paging, a page is loaded into memory only when it is needed, that is, only when the program actually tries to use it. A page that is never used is never loaded.

When a process starts, none of its pages are in memory. The valid bit in every page table entry is turned off. As the process runs, it touches pages one after another, and the operating system brings each page in on demand. This approach is sometimes called lazy loading, because the system does no work until it is forced to.

Demand paging makes programs start quickly and use less memory. Its cost is that the first use of every page is slow, because the page must be read from storage.

## Page Faults

A page fault is the event that occurs when a program tries to use a page that is not currently in main memory. A page fault is not an error. It is a normal signal from the hardware to the operating system that a page needs to be loaded.

The operating system handles a page fault in six steps. First, the hardware notices that the valid bit is off and transfers control to the operating system. Second, the operating system checks that the address really belongs to the process. If it does not, the process is stopped. Third, the operating system finds a free frame. Fourth, it reads the required page from the backing store into that frame. Fifth, it updates the page table so that the entry points to the new frame, and it turns the valid bit on. Sixth, it restarts the instruction that caused the fault. The program then continues as if nothing had happened.

Page faults are expensive. Reading a page from a hard disk takes several milliseconds, while a normal memory access takes a few nanoseconds. A page fault is therefore about a hundred thousand times slower than an ordinary memory access. For this reason, the number of page faults must be kept very small. The fraction of memory accesses that cause a page fault is called the page fault rate.

## Page Replacement Algorithms

Sooner or later, a page fault happens when there are no free frames left. The operating system must then choose a page that is already in memory and remove it, to make room for the new one. The page that is removed is called the victim. If the victim has its dirty bit set, it must be written back to storage before its frame can be reused. The rule that chooses the victim is called a page replacement algorithm.

The simplest rule is first in, first out, usually written FIFO. FIFO removes the page that has been in memory for the longest time. FIFO is easy to build, but it can make poor choices, because the oldest page may still be in constant use. FIFO also shows a strange behaviour called Belady's anomaly, in which giving a process more frames can cause more page faults instead of fewer. It is named after Laszlo Belady, who described it in 1969.

The best possible rule is the optimal algorithm. It removes the page that will not be used for the longest time in the future. No other algorithm can produce fewer page faults. Unfortunately, the optimal algorithm cannot be built, because the operating system cannot see the future. It is used only as a yardstick for judging other algorithms.

A practical rule is least recently used, written LRU. LRU removes the page that has not been used for the longest time. It rests on the idea of locality: a page that has not been used recently will probably not be used soon. LRU performs nearly as well as the optimal algorithm, but recording the exact time of every memory access is costly. Most real systems therefore use an approximation called the clock algorithm, which needs only one extra bit for each page, known as the reference bit.

## Thrashing and the Working Set

If a process does not have enough frames, it will fault again and again. Each fault removes a page that will be needed a moment later, which causes another fault. A system in this state is said to be thrashing. Thrashing means that the system spends more time moving pages in and out of memory than doing useful work. During thrashing, the processor sits almost idle while the storage device is extremely busy.

Thrashing can be understood through the working set model, proposed by Peter Denning in 1968. The working set of a process is the set of pages it has used during a recent window of time. If a process is given enough frames to hold its whole working set, it will fault rarely. If the working sets of all processes together are larger than physical memory, thrashing begins.

The cure for thrashing is to reduce the number of processes competing for memory. The operating system suspends one or more processes and gives their frames to the others. Once the remaining processes each have enough frames, the page fault rate drops and useful work resumes. Adding more physical memory also helps, because it allows more working sets to fit at the same time.
