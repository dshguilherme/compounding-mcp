"""A tiny conjugate-gradient solve with a known answer.

Solves A x = b for a symmetric positive-definite 3x3 matrix.
No third-party packages are required.
"""
from math import sqrt

A = [[4.0, 1.0, 0.0], [1.0, 3.0, 1.0], [0.0, 1.0, 2.0]]
x_exact = [1.0, 2.0, 3.0]
b = [sum(aij * xj for aij, xj in zip(row, x_exact)) for row in A]


def dot(u, v):
    return sum(ui * vi for ui, vi in zip(u, v))


def matvec(matrix, vector):
    return [dot(row, vector) for row in matrix]


def norm(vector):
    return sqrt(dot(vector, vector))


def conjugate_gradient(matrix, rhs, tolerance=1e-12, max_iter=20):
    x = [0.0] * len(rhs)
    r = [bi - ai for bi, ai in zip(rhs, matvec(matrix, x))]
    p = r[:]
    rr = dot(r, r)
    for iteration in range(1, max_iter + 1):
        ap = matvec(matrix, p)
        alpha = rr / dot(p, ap)
        x = [xi + alpha * pi for xi, pi in zip(x, p)]
        r = [ri - alpha * api for ri, api in zip(r, ap)]
        rr_next = dot(r, r)
        if sqrt(rr_next) <= tolerance:
            return x, iteration, sqrt(rr_next)
        beta = rr_next / rr
        p = [ri + beta * pi for ri, pi in zip(r, p)]
        rr = rr_next
    raise RuntimeError("conjugate gradient did not converge within max_iter")


if __name__ == "__main__":
    x, iterations, residual = conjugate_gradient(A, b)
    error = norm([xi - xe for xi, xe in zip(x, x_exact)])
    print(f"x={x}")
    print(f"iterations={iterations}")
    print(f"residual_l2={residual:.3e}")
    print(f"solution_error_l2={error:.3e}")
