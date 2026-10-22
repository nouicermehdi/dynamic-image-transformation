# Custom SAM build: install sharp for the Lambda runtime (Linux arm64), not for this machine.
build-TransformFunction:
	cp app.js params.js package.json $(ARTIFACTS_DIR)/
	cd $(ARTIFACTS_DIR) && npm install --omit=dev --no-audit --no-fund --os=linux --cpu=arm64
