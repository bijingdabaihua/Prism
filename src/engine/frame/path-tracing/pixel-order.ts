/**
 * 像素采样顺序：把 [0, count) 洗成一个随机排列。
 *
 * 采样按这张表顺序进行 —— 每帧取连续的一段，一轮正好覆盖每个像素一次。
 * 这样既保证采样点在空间上随机分布，又保证不会漏采或重复采某个像素
 * （直到进入下一轮），累加平均的分母因此可以由「轮数 + 表内位置」推出。
 *
 * 随机源是 xorshift32 驱动的 Fisher–Yates：不需要密码学质量，只要分布均匀、
 * 相邻采样在空间上不聚集。
 */
export function buildPixelOrder(count: number): Uint32Array {
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;

    let s = 0x9e3779b9 >>> 0;
    for (let i = count - 1; i > 0; i--) {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        const j = s % (i + 1);
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
    }
    return order;
}
