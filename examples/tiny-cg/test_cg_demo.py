import unittest

from cg_demo import A, b, conjugate_gradient, norm, x_exact


class ConjugateGradientTests(unittest.TestCase):
    def test_known_solution(self):
        x, iterations, residual = conjugate_gradient(A, b)
        error = norm([xi - xe for xi, xe in zip(x, x_exact)])
        self.assertLessEqual(iterations, len(b))
        self.assertLess(residual, 1e-12)
        self.assertLess(error, 1e-12)

    def test_budget_failure_is_visible(self):
        with self.assertRaisesRegex(RuntimeError, "did not converge"):
            conjugate_gradient(A, b, tolerance=1e-30, max_iter=1)


if __name__ == "__main__":
    unittest.main()
