<template>
    <div class="images-page">
        <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
            <div>
                <h1 class="mb-0">Container Images</h1>
                <div class="text-muted mt-1">Endpoint: {{ endpointDisplay }}</div>
            </div>

            <button class="btn btn-normal" :disabled="loading" @click="loadImages">
                <font-awesome-icon icon="arrows-rotate" />
                <span class="ms-1">{{ loading ? "Refreshing..." : "Refresh" }}</span>
            </button>
        </div>

        <div class="shadow-box big-padding">
            <div v-if="loading" class="text-muted">Loading image list...</div>

            <div v-else-if="imageList.length === 0" class="text-muted">
                No images found.
            </div>

            <div v-else class="table-responsive">
                <table class="table table-hover mb-0">
                    <thead>
                        <tr>
                            <th scope="col">Reference</th>
                            <th scope="col">Size</th>
                            <th scope="col">In Use</th>
                            <th scope="col">Digest</th>
                            <th scope="col">Media Type</th>
                            <th scope="col" class="text-end">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="image in imageList" :key="image.reference">
                            <td class="text-break">{{ image.reference }}</td>
                            <td>{{ image.fullSize || "-" }}</td>
                            <td>
                                <span class="badge" :class="image.inUseCount > 0 ? 'bg-warning text-dark' : 'bg-success'">
                                    {{ image.inUseCount || 0 }}
                                </span>
                            </td>
                            <td class="text-break digest">{{ image.digest || "-" }}</td>
                            <td class="text-break">{{ image.mediaType || "-" }}</td>
                            <td class="text-end">
                                <button
                                    class="btn btn-sm btn-outline-danger"
                                    :disabled="deletingReference === image.reference || image.inUseCount > 0"
                                    @click="deleteImage(image)"
                                >
                                    <font-awesome-icon icon="trash" />
                                    <span class="ms-1">{{ deletingReference === image.reference ? "Deleting..." : "Delete" }}</span>
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            loading: false,
            imageList: [],
            deletingReference: "",
        };
    },

    computed: {
        endpoint() {
            return this.$route.params.endpoint || "";
        },

        endpointDisplay() {
            return this.$root.endpointDisplayFunction(this.endpoint);
        },
    },

    watch: {
        endpoint() {
            this.loadImages();
        },
    },

    mounted() {
        this.loadImages();
    },

    methods: {
        loadImages() {
            this.loading = true;
            this.$root.emitAgent(this.endpoint, "getContainerImageList", (res) => {
                this.loading = false;

                if (res.ok) {
                    this.imageList = res.imageList || [];
                } else {
                    this.imageList = [];
                    this.$root.toastRes(res);
                }
            });
        },

        deleteImage(image) {
            const reference = image.reference;
            const inUseCount = Number(image.inUseCount || 0);

            if (inUseCount > 0) {
                this.$root.toastError(`Image is in use by ${inUseCount} container(s). Stop and remove those containers first.`);
                return;
            }

            if (!confirm(`Delete image '${reference}'?`)) {
                return;
            }

            if (!confirm(`Final confirmation: delete image '${reference}'?`)) {
                return;
            }

            this.deletingReference = reference;
            this.$root.emitAgent(this.endpoint, "deleteContainerImage", reference, (res) => {
                this.deletingReference = "";
                this.$root.toastRes(res);

                if (res.ok) {
                    this.loadImages();
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.images-page {
    .digest {
        min-width: 260px;
    }
}
</style>
