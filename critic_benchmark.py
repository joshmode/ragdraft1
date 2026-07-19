import argparse
import json
import time

from analyser import analyse
from parser import ParsedResume


def load_cases(path: str) -> list[dict]:
    with open(path, "r") as file:
        data = json.load(file)
    if not isinstance(data, list):
        raise ValueError("Benchmark fixtures must be a JSON array.")
    return data


def run_case(case: dict, provider: str, model: str, local_endpoint: str, use_critic: bool) -> dict:
    resume = ParsedResume(
        raw_text=case.get("raw_text", ""),
        contact=case.get("contact", {}),
        sections=case.get("sections", {}),
        warnings=case.get("warnings", []),
    )
    started = time.perf_counter()
    result = analyse(
        resume=resume,
        job_description=case.get("job_description", ""),
        provider=provider,
        model=model,
        local_endpoint=local_endpoint,
        use_critic=use_critic,
    )
    return {
        "id": case.get("id", ""),
        "use_critic": use_critic,
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
        "timing": result.get("timing", {}),
        "critic": result.get("critic", {}),
        "score": result.get("score", {}).get("total", 0),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixtures")
    parser.add_argument("--provider", default="gemini")
    parser.add_argument("--model", default="")
    parser.add_argument("--local-endpoint", default="")
    parser.add_argument("--output", default="critic_benchmark_results.json")
    args = parser.parse_args()

    results = []
    for case in load_cases(args.fixtures):
        results.append(run_case(case, args.provider, args.model, args.local_endpoint, False))
        results.append(run_case(case, args.provider, args.model, args.local_endpoint, True))

    with open(args.output, "w") as file:
        json.dump(results, file, indent=2)


if __name__ == "__main__":
    main()
